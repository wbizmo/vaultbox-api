import type {
  File, FileDeletion, UploadPart, UploadSession, TemporaryObject, User, Prisma
} from "@prisma/client";
import type { FastifyInstance } from "fastify";

// Compile-time guardrails for the JS API's generated Prisma data contracts.
// CI invokes TypeScript with noEmit and strict type checking.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

export type QuotaSafetyContracts = [
  Assert<Equal<User["storageUsed"], bigint>>,
  Assert<Equal<User["reservedUploadBytes"], bigint>>,
  Assert<Equal<File["size"], bigint>>,
  Assert<Equal<UploadSession["expectedSize"], bigint>>,
  Assert<Equal<TemporaryObject["bytes"], bigint>>,
  Assert<Equal<TemporaryObject["objectKey"], string>>,
  Assert<Equal<TemporaryObject["token"], string>>,
  Assert<Equal<TemporaryObject["leaseUntil"], Date>>,
  Assert<Equal<UploadSession["cleanupToken"], string | null>>,
  Assert<Equal<UploadSession["cleanupLeaseUntil"], Date | null>>,
  Assert<Equal<UploadSession["chunksCleanedAt"], Date | null>>,
  Assert<Equal<File["folderId"], string | null>>,
  Assert<Equal<UploadPart["sessionId"], string>>,
  Assert<Equal<FileDeletion["userId"], string>>
];

export const expectedUploadStates = [
  "UPLOADING", "COMPLETING", "COMPLETED", "ABORTED", "EXPIRED"
] as const satisfies readonly UploadSession["status"][];

export const ownedActiveFileFilter = (userId: string): Prisma.FileWhereInput => ({
  userId, status: "ACTIVE", folderId: null
});

export const dueCleanupFilter = (now: Date): Prisma.UploadSessionWhereInput => ({
  status: { in: ["COMPLETED", "ABORTED", "EXPIRED"] },
  chunksCleanedAt: null,
  cleanupLeaseUntil: { lte: now }
});

export type FastifyAppContract = Pick<FastifyInstance, "ready" | "inject" | "close">;
