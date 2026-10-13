// Seed script: creates two demo users with funded accounts so the app is
// immediately usable for reviewers. Run with: npm run seed
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('password123', 10);

  const alice = await prisma.user.upsert({
    where: { email: 'alice@example.com' },
    update: {},
    create: {
      email: 'alice@example.com',
      name: 'Alice',
      passwordHash,
      accounts: {
        create: [{ name: 'Main', balance: 100000n }], // $1,000.00
      },
    },
    include: { accounts: true },
  });

  const bob = await prisma.user.upsert({
    where: { email: 'bob@example.com' },
    update: {},
    create: {
      email: 'bob@example.com',
      name: 'Bob',
      passwordHash,
      accounts: {
        create: [{ name: 'Main', balance: 50000n }], // $500.00
      },
    },
    include: { accounts: true },
  });

  console.log('Seeded users:');
  console.log(`  alice@example.com / password123  (account ${alice.accounts[0].id}, $1000.00)`);
  console.log(`  bob@example.com   / password123  (account ${bob.accounts[0].id}, $500.00)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
