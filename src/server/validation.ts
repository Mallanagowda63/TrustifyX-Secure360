import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address"));
export const nameSchema = z.string().trim().min(1, "Required").max(100);
export const passwordSchema = z.string().min(1, "Required").max(128);
export const idSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+$/i, "Invalid id");
export const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export const severitySchema = z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const findingStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "FALSE_POSITIVE"]);
