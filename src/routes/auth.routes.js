const { DUMMY_HASH } = require("../lib/password-hasher");
const { clientIp } = require("../lib/client-ip");
const { recordAudit } = require("../lib/audit");
const prisma = require("../lib/prisma");
const { throttlePreHandler } = require("../lib/throttle");

// Abuse-sensitive: when Redis is down these use the shared PostgreSQL counter (never a per-process one)
// and fail closed if that is unavailable too. See lib/throttle.js.
const registerThrottle = throttlePreHandler("register", { limit: 8, windowSeconds: 600, policy: "shared" });
const loginThrottle = throttlePreHandler(
  "login",
  { limit: 10, windowSeconds: 300, policy: "shared" },
  (request) => `${clientIp(request)}:${normalizeEmail(request.body?.email || "unknown")}`
);
// Independent global caps: one account cannot be guessed at from many addresses, and one address
// cannot spray many accounts, even though each (ip, email) pair stays under its own limit.
const loginAccountThrottle = throttlePreHandler(
  "login-account",
  { limit: 30, windowSeconds: 900, policy: "shared" },
  (request) => normalizeEmail(request.body?.email || "unknown")
);
const loginAddressThrottle = throttlePreHandler(
  "login-address",
  { limit: 120, windowSeconds: 300, policy: "shared" },
  (request) => clientIp(request)
);

/** 503 for "the hashing budget is exhausted": distinct from a credential failure, never a login attempt. */
function busyReply(reply, request, error) {
  request.log.warn({ event: "password_hash_busy", reason: error.reason }, "Password hashing budget exhausted");
  reply.header("Retry-After", error.retryAfterSeconds || 2);
  return reply.code(503).send({ message: "Authentication is busy; retry shortly" });
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isStrongPassword(password) {
  return typeof password === "string" &&
    password.length >= 10 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    status: user.status,
    storageUsed: user.storageUsed.toString(),
    plan: user.plan
      ? {
          ...user.plan,
          storageLimit: user.plan.storageLimit.toString()
        }
      : undefined,
    createdAt: user.createdAt
  };
}

async function authRoutes(app) {
  app.post("/auth/register", {
    preHandler: registerThrottle,
    schema: {
      tags: ["Auth"],
      summary: "Create a new user account",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name", "email", "password"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          email: { type: "string", format: "email", maxLength: 320 },
          password: { type: "string", minLength: 10, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const name = request.body.name.trim();
    const email = normalizeEmail(request.body.email);
    const password = request.body.password;

    if (!name) return reply.code(400).send({ message: "Name is required" });
    if (!isStrongPassword(password)) {
      return reply.code(400).send({
        message: "Password must be at least 10 characters and include uppercase, lowercase, and a number"
      });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return reply.code(409).send({ message: "Email already registered" });

    const freePlan = await prisma.plan.findUnique({ where: { name: "Free" } });
    let hashedPassword;
    try {
      hashedPassword = await app.passwordHasher.hash(password);
    } catch (error) {
      if (error.code === "PASSWORD_VERIFICATION_BUSY") return busyReply(reply, request, error);
      throw error;
    }

    let user;
    try {
      // The account and its audit event commit together: a failing audit insert leaves no account behind,
      // so a retry is not met with a confusing "Email already registered".
      user = await prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            name,
            email,
            password: hashedPassword,
            planId: freePlan?.id
          },
          include: { plan: true }
        });
        await recordAudit(tx, { action: "ACCOUNT_REGISTERED", details: created.id, userId: created.id, ip: clientIp(request) });
        return created;
      });
    } catch (error) {
      if (error.code === "P2002") {
        return reply.code(409).send({ message: "Email already registered" });
      }
      throw error;
    }

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role, av: user.authVersion });
    return reply.code(201).send({ message: "Account created successfully", token, user: publicUser(user) });
  });

  app.post("/auth/login", {
    preHandler: [loginAddressThrottle, loginAccountThrottle, loginThrottle],
    schema: {
      tags: ["Auth"],
      summary: "Login and receive a JWT token",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email", maxLength: 320 },
          password: { type: "string", minLength: 1, maxLength: 128 }
        }
      }
    }
  }, async (request, reply) => {
    const email = normalizeEmail(request.body.email);
    const user = await prisma.user.findUnique({ where: { email }, include: { plan: true } });

    // Every attempt performs exactly one comparison at the production cost -- against a dummy hash when the
    // account does not exist -- and every failure looks the same, so neither the response nor the time
    // reveals whether an e-mail address is registered or what state the account is in.
    let passwordMatches;
    try {
      passwordMatches = await app.passwordHasher.compare(request.body.password, user ? user.password : DUMMY_HASH);
    } catch (error) {
      if (error.code === "PASSWORD_VERIFICATION_BUSY") return busyReply(reply, request, error);
      throw error;
    }
    if (!user || !passwordMatches) return reply.code(401).send({ message: "Invalid email or password" });

    // Only a caller who proved the password learns the account state (they need it to act on it).
    if (user.status !== "ACTIVE") {
      return reply.code(403).send({ message: `Account is ${user.status.toLowerCase()}` });
    }

    // Critical but not a state change: it is written before any token exists, so if it fails the caller
    // gets an error and no credential was issued (an accurate, retryable outcome).
    await recordAudit(prisma, { action: "LOGIN", userId: user.id, ip: clientIp(request) });

    // Sign with the session version read together with the status we just checked. If the account
    // is suspended/deleted/demoted between that read and now, the version moves on and this token
    // is already dead -- a racing login can never mint a reusable credential.
    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role, av: user.authVersion });
    return reply.send({ message: "Login successful", token, user: publicUser(user) });
  });
}

module.exports = authRoutes;
