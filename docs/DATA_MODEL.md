# نموذج البيانات

## اتفاقيات عامة

- المعرفات: `uuid` (يُولد في التطبيق أو بـ `gen_random_uuid()`).
- كل جدول أساسي يحتوي `venue_id uuid not null` يشير إلى `venues` (تجهيزًا للدمج المستقبلي — T-05).
- `created_at`, `updated_at` من نوع `timestamptz` في كل جدول.
- المبالغ: `bigint` بالقرش (T-06). أسماء الأعمدة تنتهي بـ `_piasters` أو يوضح النوع في الكود.
- الأوقات: `timestamptz`. أوقات اليوم بلا تاريخ: `time`. التواريخ: `date`.
- لا حذف فعلي للسجلات المالية (T-09). الكيانات الإعدادية تُعطل بعمود `is_active`.

## 1. المنشأة والإعدادات

### venues
| العمود | النوع | ملاحظات |
|---|---|---|
| id | uuid PK | |
| name | text | |
| logo_key | text null | مفتاح الملف في R2 |
| phone, address | text null | |
| timezone | text | افتراضي `Africa/Cairo` |
| currency | text | افتراضي `EGP` |
| buffer_minutes | int | الوقت الفاصل ≥ 0 |
| tentative_hold_hours | int | مدة صلاحية الحجز المبدئي > 0 |
| min_deposit_type | enum(`none`,`fixed`,`percent`) | |
| min_deposit_value | bigint | قروش إن fixed، أو نسبة×100 (basis points) إن percent |
| cancellation_basis | enum(`deposit`,`total_paid`) | |
| postpone_credit_mode | enum(`refund`,`services`,`both`) | |
| booking_seq, receipt_seq | bigint | عدادات الترقيم (أو sequences منفصلة) |

### cancellation_tiers
`id, venue_id, min_days_before int, refund_bps int (0–10000)`
قيد فريد: `(venue_id, min_days_before)`.

### seasons
`id, venue_id, name, start_date date, end_date date, is_active`
قيد: `start_date ≤ end_date` + Exclusion Constraint يمنع تداخل `daterange(start_date, end_date, '[]')` للمواسم النشطة في نفس المنشأة.

### event_types
`id, venue_id, name, is_wedding bool, is_active, sort_order`

### payment_methods
`id, venue_id, name, is_active, sort_order`

### expense_categories
`id, venue_id, name, is_active`

## 2. الأماكن

### spaces
`id, venue_id, name, capacity_max int null, is_active, sort_order`

### space_slots
`id, venue_id, space_id, kind enum(day, evening), start_time time, end_time time`
قيد فريد: `(space_id, kind)`. يجوز `end_time < start_time` للدلالة على تخطي منتصف الليل.

## 3. الكتالوج والباكيجات

### services
| العمود | النوع | ملاحظات |
|---|---|---|
| id, venue_id | | |
| name | text | |
| category | enum(`service`,`show`,`hospitality`) | |
| pricing_type | enum(`fixed`,`per_unit`,`per_guest`) | |
| unit_price | bigint | |
| external_fee | bigint null | رسوم دخول المتعهد الخارجي؛ null = لا يُسمح/لا رسوم |
| allow_external | bool | |
| is_active | bool | |

### packages
`id, venue_id, space_id, name, description, base_guests int, extra_guest_price bigint, is_active`

### package_prices
`id, venue_id, package_id, slot_kind enum(day, evening, full_day), season_id uuid null, price bigint`
قيد فريد: `(package_id, slot_kind, coalesce(season_id, '00000000-...'))` أو فهرس فريد جزئي لكل حالة.

### package_items
`id, venue_id, package_id, service_id, quantity int, removable bool, removal_credit bigint`

## 4. العملاء والحجوزات

### customers
`id, venue_id, name, phone, alt_phone null, notes null`
فهرس غير فريد على `(venue_id, phone)` (D-28: لا منع للتكرار).

### bookings
| العمود | النوع | ملاحظات |
|---|---|---|
| id, venue_id | | |
| booking_no | text unique | مثل `2026-0015` |
| space_id | uuid | |
| customer_id | uuid | |
| event_type_id | uuid null | مطلوب للتأكيد |
| groom_name, bride_name | text null | مطلوبان للتأكيد إن كانت المناسبة فرحًا |
| slot_kind | enum(day, evening, full_day) | |
| starts_at, ends_at | timestamptz | `ends_at > starts_at` |
| blocked_until | timestamptz | `ends_at + buffer` وقت الحفظ |
| guests | int null | مطلوب للتأكيد |
| package_id | uuid null | مطلوب للتأكيد |
| status | enum(`tentative`,`confirmed`,`cancelled`) | |
| tentative_expires_at | timestamptz null | |
| season_id | uuid null | لقطة |
| base_price, extra_guests_amount, items_total, removal_credits_total, discount_amount, total | bigint | لقطة السعر |
| cancelled_at, cancelled_by, cancel_reason | | |
| confirmed_at, confirmed_by | | |
| notes | text null | |
| created_by | uuid | |
| version | int | للتحكم في التعديل المتزامن (optimistic locking) |

**قيد منع التعارض (BR-11):**
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    space_id WITH =,
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  ) WHERE (status = 'confirmed');
```
(الحجز `completed` محسوب من `confirmed`، فيظل مشمولًا.)

### booking_items
| العمود | ملاحظات |
|---|---|
| id, venue_id, booking_id | |
| service_id | null مسموح (مرجع فقط) |
| name, category, pricing_type | نسخة وقت الإضافة |
| unit_price, quantity | |
| source | enum(`package`,`added`) |
| is_removed | للبنود المضمنة المُزالة |
| removal_credit | قيمة خصم الإزالة المنسوخة |
| is_external | |
| external_fee | |
| line_total | محسوب ومخزن للعرض؛ المرجع هو محرك التسعير |

### discount_requests
`id, venue_id, booking_id, amount bigint, reason, status enum(pending, approved, rejected), requested_by, decided_by null, decided_at null`

### booking_changes
`id, venue_id, booking_id, kind enum(postpone, items, guests, price_override), before jsonb, after jsonb, total_before, total_after, credit_resolution enum(refund, services) null, created_by`

### booking_documents
`id, venue_id, booking_id, kind enum(national_id, signed_contract, other), file_key, mime_type, size_bytes, uploaded_by`

## 5. المدفوعات

### installments
`id, venue_id, booking_id, due_date date, amount bigint, sort_order`

### payments
| العمود | ملاحظات |
|---|---|
| id, venue_id, booking_id | |
| receipt_no | text unique، متسلسل للمنشأة |
| kind | enum(`deposit`,`installment`,`payment`,`refund`) |
| amount | bigint > 0 دائمًا؛ الاتجاه من `kind` |
| payment_method_id | |
| paid_at | timestamptz |
| received_by | uuid |
| note | text null |
| voided_at, voided_by, void_reason | للإلغاء |

## 6. المصروفات

### expenses
`id, venue_id, category_id, booking_id null, amount bigint, spent_on date, description, created_by, voided_at, voided_by, void_reason`

## 7. المستخدمون والصلاحيات

### users
`id, venue_id, name, login text unique (موبايل أو اسم مستخدم), password_hash, is_owner bool, is_active bool, failed_attempts int, locked_until timestamptz null, last_login_at`

### sessions
حسب مكتبة الدخول المختارة (أو جدول `sessions(id, user_id, expires_at)`).

### roles
`id, venue_id, name, is_system bool (للأدوار الافتراضية)`

### role_permissions
`role_id, permission_key text` — المفاتيح من القائمة الثابتة في ROLES_PERMISSIONS.md.

### user_roles
`user_id, role_id`

### audit_logs
`id, venue_id, actor_id null, action text, entity_type text, entity_id uuid null, before jsonb null, after jsonb null, meta jsonb null, created_at`
فهارس على `(entity_type, entity_id)` و `(created_at)`.

## 8. فهارس مهمة

- `bookings (space_id, starts_at)` للتقويم.
- `bookings (status, starts_at)` للرئيسية.
- `payments (booking_id)`, `payments (paid_at)` للتقارير.
- `installments (due_date)`.
- `expenses (spent_on)`.
