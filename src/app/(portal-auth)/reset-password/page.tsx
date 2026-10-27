import Link from "next/link";
import { validateResetToken } from "@/server/auth/password-reset";
import { ResetForm } from "./reset-form";

export const dynamic = "force-dynamic";

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const valid = token ? await validateResetToken(token) : null;
  return (
    <div className="portal-fade-in">
      <h1 className="font-display text-3xl font-bold text-white">Choose a new password</h1>
      {valid && token ? (
        <ResetForm token={token} />
      ) : (
        <>
          <div role="alert" className="mt-8 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            This reset link is invalid or has expired. Reset links work once and expire after 30 minutes.
          </div>
          <p className="mt-6 text-sm">
            <Link href="/forgot-password" className="font-medium text-royal-400 hover:text-royal-200">Request a new link</Link>
          </p>
        </>
      )}
    </div>
  );
}
