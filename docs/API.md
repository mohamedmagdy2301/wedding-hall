# عقود طبقة الخدمات

> في الـ MVP تُستدعى هذه العمليات عبر Server Actions. كل عملية: جلسة صالحة + مدخلات صالحة (Zod) + الصلاحية المذكورة. الأخطاء ترجع بكود ثابت ورسالة عربية.

## أكواد الأخطاء العامة
`UNAUTHENTICATED`, `FORBIDDEN`, `VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT_SLOT_TAKEN`, `CONCURRENT_MODIFICATION`, `BUSINESS_RULE_VIOLATION` (مع رقم القاعدة BR-xx)، `INTERNAL_ERROR` (خطأ غير متوقع: رسالة عامة للمستخدم، ونص الخطأ فقط في سجل الخادم بلا بيانات حساسة — SEC-32).

## Auth
| العملية | المدخلات | ملاحظات |
|---|---|---|
| `auth.login` | login, password | قفل بعد محاولات فاشلة |
| `auth.logout` | — | |
| `auth.changePassword` | current, new | إلزامية بعد كلمة مؤقتة |

## Users & Roles — `users.manage`
`users.list`, `users.create(name, login, tempPassword, roleIds)`, `users.update`, `users.setActive`, `users.resetPassword`, `roles.list`, `roles.create(name, permissionKeys)`, `roles.update`, `roles.delete` (ممنوع إن كان مستخدمًا).

## Settings — `settings.manage`
`settings.get`, `settings.updateVenue(name, phone, address)`, `settings.updateTiming(bufferMinutes, tentativeHoldHours)` (يُرفض إن كسر BR-02 في أي مكان — D-51)، `settings.updatePolicies(minDeposit, cancellationBasis, tiers[], postponeCreditMode, confirmNoRefund?)` (D-73؛ `confirmNoRefund` مطلوب إن كانت كل الشرائح 0% — D-74)، إضافة/تعديل/تفعيل/تعطيل/ترتيب لـ `eventTypes`, `paymentMethods`, `expenseCategories` مع `addSuggested` (D-71)، و `setup.checklist` (للمالك).

## Catalog — `catalog.manage`
CRUD لـ `spaces` (مع `slots`، و `spaces.upcomingBookings(spaceId)` لتحذير التعطيل — D-75، D-112)، `seasons` (D-66)، `services`، `packages` (مع `prices[]` و `items[]`). لا حذف: التعطيل بـ `is_active` (D-82).
- `services.create(name, category, pricingType, unitPrice, allowExternal, externalFee)`، `services.update(serviceId, …)` (تغيير `pricingType` يُرفض إن كانت الخدمة مضمنة في باكيج — D-80)، `services.setActive(serviceId, active)`.
- `packages.create(spaceId, name, description, baseGuests, extraGuestPrice, isActive, prices[{slotKind, seasonId|null, price}], items[{serviceId, quantity, removable, removalCredit}])`.
- `packages.update(packageId, version, …نفس الحقول عدا spaceId)` و `packages.setActive(packageId, version, active)`: إن تغيّر `version` منذ فتح الصفحة ← `CONCURRENT_MODIFICATION` (D-81). التفعيل بلا سعر عادي ← `BUSINESS_RULE_VIOLATION` (BR-30، D-78).

## Pricing — `bookings.view`
| العملية | المدخلات | المخرجات |
|---|---|---|
| `pricing.quote` | spaceId, packageId, slotKind, eventDate, guests (1–100000), items[{serviceId, quantity, isExternal}] (≤ 100)، removedServiceIds[] (≤ 100، D-86)، discountAmount? (المعتمد فقط — BR-50) | تفصيل كامل `PriceBreakdown`: basePrice, seasonId (الموسم المطبق — D-88), dateSeasonId, baseGuests, extraGuestPrice, extraGuests, extraGuestsAmount, lines[], itemsTotal (شامل رسوم الخارجي — D-85), externalFeesTotal, removalCreditsTotal, subtotal, discountAmount, total |

للقراءة فقط: لا يكتب شيئًا ولا سجل عمليات، ويقرأ الأسعار الحالية في كل مرة. يُرفض: باكيج معطّل أو على مكان معطّل (BR-06)، فترة بلا سعر عادي (BR-30)، إزالة غير مسموحة (BR-33)، خارجي غير مسموح (BR-34)، إجمالي سالب (BR-35)، خصم أكبر من الإجمالي قبل الخصم (BR-52)، خدمة معطّلة أو إضافة مضمنة غير مسموحة (D-87، D-90).

## Availability — `bookings.view`
`availability.check(spaceId, eventDate, slotKind, startTime?, endTime?, excludeBookingId?)` ← `{ startsAt, endsAt, blockedUntil, confirmedConflicts[], tentativeOverlaps[] }` (D-99): السيرفر يحسب الأوقات بتوقيت القاهرة والوقت الفاصل الحالي (D-100).
`availability.calendar(spaceIds[], from, to)` ← الحجوزات للعرض بحالتها المعروضة، والنطاق ≤ 42 يومًا.

## Customers (D-106)
| العملية | الصلاحية | ملاحظات |
|---|---|---|
| `customers.lookupByPhone(phone)` | `bookings.create` | اقتراح العميل في المعالج بالموبايل أو الموبايل الثاني (D-28) |
| `customers.list(search, page)`، `customers.get(id)` | `bookings.view` | S-08، والعميل بحجوزاته |
| `customers.create(name, phone, altPhone?, notes?)`، `customers.update(id, …)` | `customers.manage` | من S-08؛ العميل الجديد من المعالج يُنشأ داخل `bookings.createTentative` |

## Bookings
| العملية | الصلاحية | ملاحظات |
|---|---|---|
| `bookings.createTentative(spaceId, eventDate, slotKind, startTime?, endTime?, customer: {customerId} \| {name, phone, altPhone?}, eventTypeId?, groomName?, brideName?, packageId?, guests?, items[], removedServiceIds[], notes?)` | create | الحد الأدنى D-09؛ يرجع الرقم وتاريخ الانتهاء والتحذيرات (BR-12، D-102) |
| `bookings.updateTentative(id, version, …نفس الحقول)` | edit | للمبدئي فقط؛ يعيد التسعير إن تغيّرت مدخلات السعر، ولا يجدد الصلاحية (D-101) |
| `bookings.extendTentative(id, version)` | edit | `tentative_expires_at = الآن + tentative_hold_hours` (D-101) |
| `bookings.createConfirmed` | create + payments.record | مع عربون وأقساط |
| `bookings.confirm(id, version, deposit, installments[])` | confirm + payments.record | BR-21/22؛ المرحلة 6، والانتقال للحالة المؤكدة عبر `markConfirmed` فقط (D-97) |
| `bookings.updateDetails(id, version, eventTypeId, groomName, brideName, notes, customerId)` | edit | بيانات غير مالية لأي حجز غير ملغي |
| `bookings.updateItems(id, version, changes, installments?, creditResolution?)` | edit | BR-40..43؛ يشمل تغيير عدد المعازيم (D-35)، وإعادة ضبط الأقساط إن تغيّر الإجمالي (D-34) |
| `bookings.postpone(id, version, newDate, slotKind, times, creditResolution?)` | postpone | BR-80..85 |
| `bookings.cancelPreview(id)` | cancel | الأيام، الشريحة، الأساس، المقترح |
| `bookings.cancel(id, version, refundAmount, methodId?, reason)` | cancel (+ payments.refund إن وُجد استرداد) | BR-70..76؛ `methodId` مطلوب إن كان `refundAmount > 0` (D-47) |
| `bookings.get`, `bookings.list(filters)` | view | |

## Discounts
`discounts.request(bookingId, amount, reason)` — request
`discounts.decide(requestId, approve, note?)` — approve
`discounts.listPending` — approve

## Payments
`payments.record(bookingId, kind, amount, methodId, paidAt, note?)` — record
`payments.void(paymentId, reason)` — void
`payments.refund(bookingId, amount, methodId, reason)` — refund
`installments.set(bookingId, installments[])` — record
`collections.list(from, to, overdueOnly?)` — record

## Documents
`documents.upload(bookingId, kind, file)` — upload (حد للحجم والنوع)
`documents.getViewUrl(documentId)` — `documents.view_id` لنوع البطاقة؛ رابط مؤقت + سجل

## Expenses
`expenses.list`, `expenses.create`, `expenses.void(reason)`

## Reports
`reports.dashboard` — حسب صلاحيات المستخدم
`reports.revenue(from, to, basis: collected|contracted)` — financial
`reports.collections(from, to)` — operational
`reports.expenses(from, to)` — financial
`reports.profit(from, to)` — financial
`reports.bookingsBreakdown(from, to)` — operational

## Audit — `audit.view`
`audit.list(filters)`
