const bcrypt = require("bcryptjs");
const prisma = require("../src/lib/prisma");

const gb = (value) => BigInt(value) * 1024n * 1024n * 1024n;

async function main() {
  const freePlan = await prisma.plan.upsert({
    where: { name: "Free" },
    update: { priceMonthly: 0, storageLimit: gb(1) },
    create: { name: "Free", priceMonthly: 0, storageLimit: gb(1) }
  });

  await prisma.plan.upsert({
    where: { name: "Basic" },
    update: { priceMonthly: 5, storageLimit: gb(20) },
    create: { name: "Basic", priceMonthly: 5, storageLimit: gb(20) }
  });

  await prisma.plan.upsert({
    where: { name: "Pro" },
    update: { priceMonthly: 12, storageLimit: gb(100) },
    create: { name: "Pro", priceMonthly: 12, storageLimit: gb(100) }
  });

  await prisma.user.upsert({
    where: { email: "admin@vaultbox.dev" },
    update: {
      role: "ADMIN",
      status: "ACTIVE",
      planId: freePlan.id
    },
    create: {
      name: "VaultBox Admin",
      email: "admin@vaultbox.dev",
      password: await bcrypt.hash("Admin123!", 10),
      role: "ADMIN",
      status: "ACTIVE",
      planId: freePlan.id
    }
  });

  await prisma.user.upsert({
    where: { email: "user@vaultbox.dev" },
    update: {
      role: "USER",
      status: "ACTIVE",
      planId: freePlan.id
    },
    create: {
      name: "VaultBox User",
      email: "user@vaultbox.dev",
      password: await bcrypt.hash("User123!", 10),
      role: "USER",
      status: "ACTIVE",
      planId: freePlan.id
    }
  });

  console.log("Seed completed");
  console.log("Admin: admin@vaultbox.dev / Admin123!");
  console.log("User: user@vaultbox.dev / User123!");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
