const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");
const cache = require("../lib/cache");
const { throttlePreHandler } = require("../lib/throttle");

const registerThrottle = throttlePreHandler("register", { limit: 8, windowSeconds: 600 });
const loginThrottle = throttlePreHandler(
  "login",
  { limit: 10, windowSeconds: 300 },
  (request) => `${request.ip}:${normalizeEmail(request.body?.email || "unknown")}`
);

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
    const hashedPassword = await bcrypt.hash(password, 12);

    let user;
    try {
      user = await prisma.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          planId: freePlan?.id
        },
        include: { plan: true }
      });
    } catch (error) {
      if (error.code === "P2002") {
        return reply.code(409).send({ message: "Email already registered" });
      }
      throw error;
    }

    await prisma.auditLog.create({
      data: {
        action: "ACCOUNT_REGISTERED",
        userId: user.id,
        ip: request.ip
      }
    });

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    return reply.code(201).send({ message: "Account created successfully", token, user: publicUser(user) });
  });

  app.post("/auth/login", {
    preHandler: loginThrottle,
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

    if (!user) return reply.code(401).send({ message: "Invalid email or password" });
    if (user.status !== "ACTIVE") {
      return reply.code(403).send({ message: `Account is ${user.status.toLowerCase()}` });
    }

    const passwordMatches = await bcrypt.compare(request.body.password, user.password);
    if (!passwordMatches) return reply.code(401).send({ message: "Invalid email or password" });

    await Promise.all([
      prisma.auditLog.create({
        data: { action: "LOGIN", userId: user.id, ip: request.ip }
      }),
      cache.setJson("auth-user", user.id, {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status
      }, 10)
    ]);

    const token = app.jwt.sign({ id: user.id, email: user.email, role: user.role });
    return reply.send({ message: "Login successful", token, user: publicUser(user) });
  });
}

module.exports = authRoutes;
