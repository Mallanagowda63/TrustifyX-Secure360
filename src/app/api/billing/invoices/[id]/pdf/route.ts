import { authedRoute, notFound } from "@/server/api";
import { prisma } from "@/server/db";
import { renderInvoicePdf } from "@/server/billing/invoice-pdf";

export const GET = authedRoute<{ id: string }>("billing.read", async ({ ctx, params }) => {
  const inv = await prisma.invoice.findFirst({
    where: { id: params.id, orgId: ctx.org.id },
    include: { payment: true, subscription: { include: { plan: true } } },
  });
  if (!inv) throw notFound("Invoice");
  const pdf = await renderInvoicePdf(inv);
  return new Response(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${inv.number}.pdf"` },
  });
});
