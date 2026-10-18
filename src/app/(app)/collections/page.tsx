import Link from "next/link";
import { CollectionsTable } from "@/components/payments/collections-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/lib/i18n";
import { collectionsSchema } from "@/modules/payments/schemas";
import { getCollectionsPageData } from "@/server/dal";

const tc = t.payments.collections;

/** S-09 (`payments.record`, D-123, D-127). Dates come from the URL and are validated (SEC-20); invalid ones are dropped. */
export default async function CollectionsPage({ searchParams }: PageProps<"/collections">) {
  const raw = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
  const pick = (key: "from" | "to") => {
    const value = one(raw[key]);
    return collectionsSchema.shape[key].safeParse(value).success ? value : undefined;
  };
  const data = await getCollectionsPageData(collectionsSchema.parse({ from: pick("from"), to: pick("to") }));

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">{tc.title}</h1>
      <p className="text-sm text-muted-foreground">{tc.hint}</p>
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div className="grid gap-1.5">
          <Label htmlFor="collections-from">{tc.from}</Label>
          <Input id="collections-from" type="date" name="from" defaultValue={data.from ?? ""} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="collections-to">{tc.to}</Label>
          <Input id="collections-to" type="date" name="to" defaultValue={data.to} />
        </div>
        <Button type="submit">{tc.apply}</Button>
        <Button asChild variant="outline">
          <Link href="/collections">{tc.reset}</Link>
        </Button>
      </form>
      <CollectionsTable rows={data.rows} options={data.paymentOptions} />
    </section>
  );
}
