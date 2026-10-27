import { MfaResetActions } from "./mfa-reset-actions";

export const dynamic = "force-dynamic";

export default async function MfaResetPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <div className="portal-fade-in">
      <h1 className="font-display text-3xl font-bold text-white">Two-factor authentication reset</h1>
      {token ? (
        <MfaResetActions token={token} />
      ) : (
        <div role="alert" className="mt-8 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-100">
          This link is incomplete. Open the link from the email again.
        </div>
      )}
    </div>
  );
}
