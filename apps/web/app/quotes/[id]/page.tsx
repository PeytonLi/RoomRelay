import QuoteClient from "./quote-client";

export const dynamic = "force-dynamic";

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuoteClient quoteId={id} />;
}
