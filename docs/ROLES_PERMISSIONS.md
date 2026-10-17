# الأدوار والصلاحيات

## المبادئ

- قائمة الصلاحيات **ثابتة في الكود**؛ القاعة تركّب منها الأدوار ولا تخترع صلاحيات جديدة.
- فحص الصلاحية يتم **على السيرفر** في طبقة الخدمات لكل عملية، والواجهة تخفي ما لا يُسمح به للراحة فقط.
- المالك (`is_owner`) يملك كل الصلاحيات ضمنيًا ولا يحتاج دورًا.
- المستخدم قد يملك أكثر من دور؛ صلاحياته = اتحاد صلاحيات أدواره.

## قائمة الصلاحيات

| المفتاح | الوصف | حساسة |
|---|---|---|
| `bookings.view` | عرض الحجوزات والتقويم | |
| `bookings.create` | إنشاء حجز مبدئي/مؤكد | |
| `bookings.edit` | تعديل بيانات وبنود الحجز | |
| `bookings.confirm` | تأكيد حجز مبدئي | |
| `bookings.postpone` | تأجيل حجز | |
| `bookings.cancel` | إلغاء حجز | ✔ |
| `discounts.request` | طلب خصم | |
| `discounts.approve` | الموافقة على الخصم/تطبيقه مباشرة | ✔ |
| `payments.record` | تسجيل تحصيل | |
| `payments.void` | إلغاء دفعة | ✔ |
| `payments.refund` | تسجيل استرداد | ✔ |
| `documents.upload` | رفع مستندات | |
| `documents.view_id` | رؤية صور البطاقات | ✔ |
| `customers.manage` | إدارة العملاء | |
| `catalog.manage` | الأماكن، الخدمات، الباكيجات، الأسعار، المواسم | ✔ |
| `expenses.view` | عرض المصروفات | |
| `expenses.record` | تسجيل مصروف | |
| `expenses.void` | إلغاء مصروف | ✔ |
| `reports.operational` | تقارير الحجوزات والتحصيل والمتبقي | |
| `reports.financial` | الإيرادات والمصروفات وصافي الربح | ✔ |
| `settings.manage` | إعدادات المنشأة والسياسات | ✔ |
| `users.manage` | الموظفون والأدوار | ✔ |
| `audit.view` | سجل العمليات | ✔ |

## الأدوار الافتراضية (قابلة للتعديل)

| الصلاحية | مدير | استقبال/حجوزات | محاسب |
|---|:-:|:-:|:-:|
| bookings.view | ✔ | ✔ | ✔ |
| bookings.create | ✔ | ✔ | |
| bookings.edit | ✔ | ✔ | |
| bookings.confirm | ✔ | ✔ | ✔ |
| bookings.postpone | ✔ | ✔ | |
| bookings.cancel | ✔ | | |
| discounts.request | ✔ | ✔ | |
| discounts.approve | ✔ | | |
| payments.record | ✔ | ✔ | ✔ |
| payments.void | ✔ | | |
| payments.refund | ✔ | | ✔ |
| documents.upload | ✔ | ✔ | |
| documents.view_id | ✔ | | |
| customers.manage | ✔ | ✔ | |
| catalog.manage | ✔ | | |
| expenses.view | ✔ | | ✔ |
| expenses.record | ✔ | | ✔ |
| expenses.void | ✔ | | |
| reports.operational | ✔ | ✔ | ✔ |
| reports.financial | ✔ | | ✔ |
| settings.manage | | | |
| users.manage | | | |
| audit.view | ✔ | | |

> `settings.manage` و `users.manage` للمالك افتراضيًا، ويمكنه منحهما لأي دور.
