/*
  Warnings:

  - Added the required column `stateHash` to the `SsoCode` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "SsoCode" ADD COLUMN     "stateHash" TEXT NOT NULL;
