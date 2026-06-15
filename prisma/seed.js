const prisma = require("../src/lib/prisma");

const gb = (value) => BigInt(value) * 1024n * 1024n * 1024n;

async function main() {
  await prisma.plan.upsert({
    where: { name: "Free" },
    update: {
      priceMonthly: 0,
      storageLimit: gb(1)
    },
    create: {
      name: "Free",
      priceMonthly: 0,
      storageLimit: gb(1)
    }
  });

  await prisma.plan.upsert({
    where: { name: "Basic" },
    update: {
      priceMonthly: 5,
      storageLimit: gb(20)
    },
    create: {
      name: "Basic",
      priceMonthly: 5,
      storageLimit: gb(20)
    }
  });

  await prisma.plan.upsert({
    where: { name: "Pro" },
    update: {
      priceMonthly: 12,
      storageLimit: gb(100)
    },
    create: {
      name: "Pro",
      priceMonthly: 12,
      storageLimit: gb(100)
    }
  });

  console.log("Plans seeded");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
