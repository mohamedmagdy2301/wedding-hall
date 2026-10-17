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
| timezone | text | افتراضي `Africa/Cairo`؛ للمستقبل فقط ولا يُعدّل من الواجهة، والكود يستخدم ثابت `Africa/Cairo` (T-16) |
| currency | text | افتراضي `EGP` |
| buffer_minutes | int | الوقت الفاصل ≥ 0 |
| tentative_hold_hours | int | مدة صلاحية الحجز المبدئي > 0 |
| min_deposit_type | enum(`none`,`fixed`,`percent`) | |
| min_deposit_value | bigint | قروش إن fixed، أو نسبة×100 (basis points) إن percent |
| cancellation_basis | enum(`deposit`,`total_paid`) | |
| postpone_credit_mode | enum(`refund`,`services`,`both`) | |
| booking_seq, receipt_seq | bigint | عدادات الترقيم (أو sequences منفصلة) |

### cancellation_tiers
`id, venue_id, min_days_before int ≥ 0, refund_bps int (0–10000)`
قيد فريد: `(venue_id, min_days_before)`. تُستبدل كمجموعة واحدة عند الحفظ، والنسبة لا تقل كلما زادت الأيام (BR-77، يُفحص في الكود). هذه السياسة **الحالية** للحجوزات التي ستتأكد؛ كل حجز مؤكد يحمل لقطته (D-68).

### seasons
`id, venue_id, name, start_date date, end_date date, is_active`
قيد: `start_date ≤ end_date` + Exclusion Constraint `seasons_no_overlap` يمنع تداخل `daterange(start_date, end_date, '[]')` للمواسم النشطة في نفس المنشأة.

### event_types
`id, venue_id, name, is_wedding bool, is_active, sort_order`

### payment_methods
`id, venue_id, name, is_active, sort_order`

### expense_categories
`id, venue_id, name, is_active`

> **الأسماء فريدة** داخل كل قائمة إعدادية (هنا وفي `spaces`) على `(venue_id, lower(name))`، شاملة المعطّل (D-72).

## 2. الأماكن

### spaces
`id, venue_id, name, capacity_max int null, is_active, sort_order`

### space_slots
`id, venue_id, space_id, kind enum(day, evening), start_time time, end_time time`
قيد فريد: `(space_id, kind)`. يجوز `end_time < start_time` للدلالة على تخطي منتصف الليل في الفترة المسائية فقط؛ النهارية `start_time < end_time` (D-69). لكل مكان الفترتان دائمًا (BR-01)، وفحص BR-02 بين الفترتين والوقت الفاصل في الكود مع قفل صف المنشأة.

## 3. الكتالوج والباكيجات

### services
| العمود | النوع | ملاحظات |
|---|---|---|
| id, venue_id | | |
| name | text | |
| category | enum(`service`,`show`,`hospitality`) | |
| pricing_type | enum(`fixed`,`per_unit`,`per_guest`) | |
| unit_price | bigint | |
| external_fee | bigint not null default 0 | رسوم دخول المتعهد الخارجي، ثابتة لكل بند ولا تُضرب في الكمية (D-39) |
| allow_external | bool | يحدد السماح بالمتعهد الخارجي (D-39) |
| is_active | bool | |

الاسم فريد على `(venue_id, lower(name))` شاملًا المعطّل (D-76). `unit_price ≥ 0`، `external_fee ≥ 0` و = 0 إن لم يكن `allow_external` (D-79). `pricing_type` لا يتغير ما دامت الخدمة مضمنة في باكيج (D-80).

### packages
`id, venue_id, space_id, name, description null, base_guests int, extra_guest_price bigint, is_active, version int`
الاسم فريد على `(space_id, lower(name))` شاملًا المعطّل (D-76). `space_id` لا يتغير بعد الإنشاء، ولا يُنشأ باكيج على مكان معطّل (D-77). `base_guests` 0–100000، `extra_guest_price ≥ 0`، الوصف ≤ 500 (D-79). `version` للتحكم في التعديل المتزامن ويشمل الأسعار والبنود (D-81). الباكيج النشط له سعر عادي واحد على الأقل، يُفحص في الكود تحت قفل صف الباكيج (D-78).

### package_prices
`id, venue_id, package_id, slot_kind enum(day, evening, full_day), season_id uuid null, price bigint`
قيد فريد: `(package_id, slot_kind, season_id)` بـ `NULLS NOT DISTINCT` (السعر العادي `season_id = null` مرة واحدة لكل فترة). `price > 0`. سعر الموسم لفترة يتطلب سعرًا عاديًا لنفس الفترة (D-78).

### package_items
`id, venue_id, package_id, service_id, quantity int, removable bool, removal_credit bigint`
قيد فريد: `(package_id, service_id)` (D-80). `quantity` 1–10000، و = 1 للخدمة الثابتة وبالفرد (يُفحص في الكود). `removal_credit ≥ 0` و = 0 إن لم تكن `removable` (D-79).

> الأسعار والبنود تُحفظ مع الباكيج كمجموعة واحدة (D-81). الحجوزات لا تشير إلى صفوفهما بل تنسخ ما تحتاجه (BR-37). الخدمات والباكيجات لا تُحذف؛ التعطيل فقط (D-82).

## 4. العملاء والحجوزات

### customers
`id, venue_id, name, phone, alt_phone null, notes null`
فهرس غير فريد على `(venue_id, phone)` (D-28: لا منع للتكرار). أرقام الموبايل تُخزن موحّدة بصيغة `01XXXXXXXXX` (D-52).

### bookings
| العمود | النوع | ملاحظات |
|---|---|---|
| id, venue_id | | |
| booking_no | text | مثل `2026-0015`؛ فريد على `(venue_id, booking_no)` (D-42) |
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
| season_id | uuid null | لقطة: الموسم الذي طُبق سعره، وفارغ مع السعر العادي (D-88) |
| base_price, extra_guests_amount, items_total, removal_credits_total, discount_amount, total | bigint | لقطة السعر |
| base_guests | int null | لقطة من الباكيج وقت التأكيد (D-35) |
| extra_guest_price | bigint null | لقطة من الباكيج وقت التأكيد؛ تُستخدم لرد تخفيض المعازيم (D-35) |
| cancellation_basis | enum(`deposit`,`total_paid`) null | لقطة سياسة الإلغاء وقت التأكيد (D-68) |
| cancellation_tiers | jsonb null | لقطة الشرائح وقت التأكيد: `[{min_days_before, refund_bps}]` (D-68)؛ تُطبع في العقد ويُحسب بها الإلغاء (BR-71، BR-72) |
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
| source | enum(`package`,`added`,`guest_adjustment`) — `guest_adjustment` بنود زيادة المعازيم بعد التأكيد بالأسعار الحالية (D-35) |
| is_removed | للبنود المضمنة المُزالة |
| removal_credit | قيمة خصم الإزالة المنسوخة |
| is_external | |
| external_fee | |
| line_total | محسوب ومخزن للعرض؛ المرجع هو محرك التسعير. بإشارة: المضمن 0، المضمن المُزال − `removal_credit`، الخارجي `external_fee`، المضاف الداخلي `unit_price` (ثابت) أو `unit_price × quantity` (D-84) |

`unit_price` = ما تحاسب عليه القاعة للوحدة، فهو 0 للمضمن وللخارجي (D-84، D-91). `quantity` للبند بالفرد = عدد المعازيم الذي يغطيه وقت تسعيره (D-84). `bookings.items_total` = Σ `line_total` للبنود غير المضمنة، شاملًا رسوم الخارجي (D-85).

### discount_requests
`id, venue_id, booking_id, amount bigint, reason, status enum(pending, approved, rejected), requested_by, decided_by null, decided_at null`

### booking_changes
`id, venue_id, booking_id, kind enum(postpone, items, guests, price_override, discount), before jsonb, after jsonb, total_before, total_after, credit_resolution enum(refund, services) null, created_by`

### booking_documents
`id, venue_id, booking_id, kind enum(national_id, signed_contract, other), file_key, mime_type, size_bytes, uploaded_by`

## 5. المدفوعات

### installments
`id, venue_id, booking_id, due_date date, amount bigint, sort_order`
الجدول اختياري؛ إن وُجد: العربون + Σ الأقساط = الإجمالي، وآخر `due_date` ≤ يوم الحفلة − 1 (BR-65).

### payments
| العمود | ملاحظات |
|---|---|
| id, venue_id, booking_id | |
| receipt_no | text، متسلسل للمنشأة بلا تصفير (`000001`)؛ فريد على `(venue_id, receipt_no)` (D-42) |
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
`id, venue_id, name, login text (موبايل موحّد أو اسم مستخدم), password_hash, is_owner bool, is_active bool, must_change_password bool, failed_attempts int, locked_until timestamptz null, last_login_at`
قيد فريد: `(venue_id, login)` (D-42)، و `login` مخزن موحّدًا بحروف صغيرة (P1-04). `must_change_password` يُجبر تغيير كلمة المرور المؤقتة (D-45، SEC-05). `password_hash` بصيغة PHC لـ Argon2id مع معاملاته (D-64، P1-09).

### sessions
`id, user_id, token_hash, expires_at, last_seen_at, created_at` — يُخزن hash التوكن فقط لا التوكن نفسه (D-61). بلا `venue_id`؛ تتبع المنشأة عبر `user_id` (D-63). وكذلك `role_permissions` و `user_roles` أدناه.

### roles
`id, venue_id, name, is_system bool (للأدوار الافتراضية)`
قيد فريد: `(venue_id, name)`. الدور الذي عليه موظفون لا يُحذف (المفتاح الأجنبي في `user_roles` بـ RESTRICT — P1-06).

### role_permissions
`role_id, permission_key text` — المفاتيح من القائمة الثابتة في ROLES_PERMISSIONS.md.

### user_roles
`user_id, role_id`

### audit_logs
`id, venue_id, actor_id null, action text, entity_type text, entity_id uuid null, before jsonb null, after jsonb null, meta jsonb null, created_at`
فهارس على `(entity_type, entity_id)` و `(created_at)` و `(actor_id, created_at)`. trigger يرفض UPDATE و DELETE (SEC-42).

## 8. فهارس مهمة

- `bookings (space_id, starts_at)` للتقويم.
- `bookings (status, starts_at)` للرئيسية.
- `payments (booking_id)`, `payments (paid_at)` للتقارير.
- `installments (due_date)`.
- `expenses (spent_on)`.
