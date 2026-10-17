/**
 * The fixed permission list (ROLES_PERMISSIONS.md). Venues compose roles from these keys
 * and cannot invent new ones. Labels live in the i18n catalog under `permissions`.
 */
export const PERMISSIONS = [
  { key: "bookings.view", sensitive: false },
  { key: "bookings.create", sensitive: false },
  { key: "bookings.edit", sensitive: false },
  { key: "bookings.confirm", sensitive: false },
  { key: "bookings.postpone", sensitive: false },
  { key: "bookings.cancel", sensitive: true },
  { key: "discounts.request", sensitive: false },
  { key: "discounts.approve", sensitive: true },
  { key: "payments.record", sensitive: false },
  { key: "payments.void", sensitive: true },
  { key: "payments.refund", sensitive: true },
  { key: "documents.upload", sensitive: false },
  { key: "documents.view_id", sensitive: true },
  { key: "customers.manage", sensitive: false },
  { key: "catalog.manage", sensitive: true },
  { key: "expenses.view", sensitive: false },
  { key: "expenses.record", sensitive: false },
  { key: "expenses.void", sensitive: true },
  { key: "reports.operational", sensitive: false },
  { key: "reports.financial", sensitive: true },
  { key: "settings.manage", sensitive: true },
  { key: "users.manage", sensitive: true },
  { key: "audit.view", sensitive: true },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Default roles created by setup-venue (ROLES_PERMISSIONS.md). Editable afterwards (P1-06). */
export const DEFAULT_ROLES: ReadonlyArray<{ name: string; permissions: readonly PermissionKey[] }> = [
  {
    name: "مدير",
    permissions: PERMISSION_KEYS.filter((k) => k !== "settings.manage" && k !== "users.manage"),
  },
  {
    name: "استقبال/حجوزات",
    permissions: [
      "bookings.view",
      "bookings.create",
      "bookings.edit",
      "bookings.confirm",
      "bookings.postpone",
      "discounts.request",
      "payments.record",
      "documents.upload",
      "customers.manage",
      "reports.operational",
    ],
  },
  {
    name: "محاسب",
    permissions: [
      "bookings.view",
      "bookings.confirm",
      "payments.record",
      "payments.refund",
      "expenses.view",
      "expenses.record",
      "reports.operational",
      "reports.financial",
    ],
  },
];

/** A user's permissions: the union of their roles'; the owner implicitly has all of them. */
export function effectivePermissions(isOwner: boolean, rolePermissionKeys: Iterable<string>): Set<PermissionKey> {
  if (isOwner) return new Set(PERMISSION_KEYS);
  const result = new Set<PermissionKey>();
  for (const key of rolePermissionKeys) if (isPermissionKey(key)) result.add(key);
  return result;
}

/** Keys in `requested` that the granter does not hold (BR-102: non-owners grant only what they have). */
export function ungrantableKeys(granter: ReadonlySet<PermissionKey>, requested: Iterable<PermissionKey>) {
  return [...new Set(requested)].filter((key) => !granter.has(key));
}
