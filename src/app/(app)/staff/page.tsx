import { StaffScreen } from "@/components/staff/staff-screen";
import { t } from "@/lib/i18n";
import { getStaffPageData } from "@/server/dal";

/** S-15 (`users.manage`). */
export default async function StaffPage() {
  const data = await getStaffPageData();
  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">{t.staff.title}</h1>
      <StaffScreen {...data} />
    </section>
  );
}
