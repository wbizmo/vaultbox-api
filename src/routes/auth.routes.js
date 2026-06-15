const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");

async function authRoutes(app) {
  app.post("/auth/register", {
    schema: {
      tags: ["Auth"],
      summary: "Create a new user account",
      body: {
        type: "object",
        required: ["name", "email", "password"],
        properties: {
          name: {
            type: "string",
          },
          email: {
            type: "string",
            format: "email",
          },
          password: {
            type: "string",
            minLength: 6,
          }
        }
      },
      response: {
        201: {
          type: "object",
          properties: {
            message: { type: "string" },
            token: { type: "string" },
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                role: { type: "string" },
                status: { type: "string" },
                storageUsed: { type: "string" },
                createdAt: { type: "string" }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { name, email, password } = request.body;

    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return reply.code(409).send({ message: "Email already registered" });
    }

    const freePlan = await prisma.plan.findUnique({
      where: { name: "Free" }
    });

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
        planId: freePlan?.id
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        status: true,
        storageUsed: true,
        createdAt: true
      }
    });

    const token = app.jwt.sign({
      id: user.id,
      email: user.email,
      role: user.role
    });

    return reply.code(201).send({
      message: "Account created successfully",
      token,
      user: {
        ...user,
        storageUsed: user.storageUsed.toString()
      }
    });
  });

  app.post("/auth/login", {
    schema: {
      tags: ["Auth"],
      summary: "Login and receive a JWT token",
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: {
            type: "string",
            format: "email",
          },
          password: {
            type: "string",
          }
        }
      },
      response: {
        200: {
          type: "object",
          properties: {
            message: { type: "string" },
            token: { type: "string" },
            user: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                email: { type: "string" },
                role: { type: "string" },
                status: { type: "string" },
                storageUsed: { type: "string" },
                plan: {
                  type: "object",
                  nullable: true,
                  properties: {
                    id: { type: "string" },
                    name: { type: "string" },
                    priceMonthly: { type: "number" },
                    storageLimit: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { email, password } = request.body;

    const user = await prisma.user.findUnique({
      where: { email },
      include: { plan: true }
    });

    if (!user) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    if (user.status !== "ACTIVE") {
      return reply.code(403).send({ message: `Account is ${user.status.toLowerCase()}` });
    }

    const passwordMatches = await bcrypt.compare(password, user.password);

    if (!passwordMatches) {
      return reply.code(401).send({ message: "Invalid email or password" });
    }

    await prisma.auditLog.create({
      data: {
        action: "LOGIN",
        userId: user.id,
        ip: request.ip
      }
    });

    const token = app.jwt.sign({
      id: user.id,
      email: user.email,
      role: user.role
    });

    return reply.send({
      message: "Login successful",
      token,
      user: {
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
          : null
      }
    });
  });
}

module.exports = authRoutes;
