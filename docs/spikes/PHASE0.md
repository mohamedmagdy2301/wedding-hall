# تقرير تجارب التحقق — المرحلة 0

> الحالة: **جزئي** — التجارب المحلية مكتملة؛ التجارب على Cloudflare و Neon الفعليين بانتظار الحسابات.
> آخر تحديث: 2026-10-17

## ملخص

| # | التجربة | النتيجة | ملاحظات |
|---|---|---|---|
| A-01 | شروط الخطط المجانية | ✅ مع ملاحظتين | Neon لا يذكر صراحة السماح بالاستخدام التجاري على الخطة المجانية، وتفعيل R2 غالبًا يحتاج كارت (انظر التفاصيل) |
| A-02 | Next.js على Workers + Server Action تقرأ من القاعدة | ✅ محليًا على workerd — ⏳ النشر الفعلي | تطلّب تعطيل Cache Components (انظر "انحرافات") |
| A-03 | تشفير كلمة المرور داخل حدود Workers المجانية | ⚠️ مؤشر سلبي محليًا — ⏳ القياس الفعلي | PBKDF2 بـ 100 ألف تكرار ≈ 28 مللي ثانية CPU محليًا مقابل حد 10 مللي ثانية |
| A-04 | `btree_gist` + قيد `bookings_no_overlap` | ✅ على PostgreSQL 17 محليًا — ⏳ على Neon | Neon يدعم `btree_gist` 1.7 على PG17 (من وثائقه) |
| A-05 | Transaction حقيقية من Workers | ✅ محليًا على workerd عبر driver Neon — ⏳ على Workers + Neon | |

---

## A-01 — الخطط المجانية (مراجعة 2026-10-17 من المصادر الرسمية)

### Cloudflare Workers (Free) — https://developers.cloudflare.com/workers/platform/limits/
- 100,000 طلب/يوم (يُعاد الضبط منتصف الليل UTC). عند التجاوز: خطأ 1027.
- **10 مللي ثانية CPU لكل طلب**، مع "مرونة مدمجة" للتجاوز النادر؛ التجاوز المتكرر يُنهي التنفيذ (خطأ 1102). انتظار الشبكة وقاعدة البيانات لا يُحسب.
- **حجم الـ Worker: 64 ميجا غير مضغوط لكل الخطط** (تغيّر في 2026-09-04؛ حد 3 ميجا القديم أُلغي) — https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/
- ذاكرة 128 ميجا لكل isolate؛ 50 subrequest لكل طلب.
- طلبات الملفات الثابتة (static assets) مجانية وغير محدودة ولا تُحسب من الـ 100 ألف.
- الشروط (https://www.cloudflare.com/terms/): لا يوجد قيد على الاستخدام التجاري. القيد الوحيد ذو الصلة: ممنوع جمع بيانات بطاقات ائتمان على خدمة مجانية (لا ينطبق؛ لا دفع إلكتروني — D-32).
- الخطة المدفوعة للمقارنة: 5 دولار/شهر، 10 مليون طلب، CPU حتى 5 دقائق (افتراضي 30 ثانية).

### Cloudflare R2 — https://developers.cloudflare.com/r2/pricing/
- 10 جيجا تخزين/شهر، مليون عملية Class A، 10 مليون Class B، والـ egress مجاني. **الافتراض كما هو.**
- الروابط الموقعة (presigned) مدعومة لـ GET/PUT بمدة من ثانية إلى 7 أيام، على نطاق `r2.cloudflarestorage.com` فقط.
- ⚠️ **الكارت:** الوثائق الرسمية لا تذكره، لكن تقارير منتدى Cloudflare تفيد بأن التفعيل يتطلب وسيلة دفع (مع حجز مؤقت 5 دولار). يُعامل كمطلوب لكل حساب منشأة (D-44). غير مطلوب قبل المرحلة 9.

### Neon (Free) — https://neon.com/pricing ، https://neon.com/docs/introduction/plans
- 100 مشروع؛ **1 جيجا لكل مشروع** (كان 0.5 — تحسّن يخدم افتراض حجم القاعدة في DECISIONS ج/A-05)، 20 جيجا للحساب.
- 100 CU-hour لكل مشروع شهريًا، حتى 2 CU. Scale-to-zero بعد 5 دقائق إجباري على المجاني.
- 10 branches لكل مشروع؛ نافذة استعادة 6 ساعات؛ 5 جيجا egress شهريًا.
- عند نفاد الحوسبة: تُوقف حتى الشهر التالي (لا حذف للبيانات). عند امتلاء التخزين: الكتابة تفشل.
- PostgreSQL 14–18 متاح؛ منطقة Frankfurt `aws-eu-central-1` متاحة.
- `btree_gist` مدعوم (1.7 على PG17) — https://neon.com/docs/extensions/pg-extensions
- ⚠️ **الاستخدام التجاري:** لم يُعثر على نص يمنعه أو يسمح به صراحة. وثيقة الإنتاج تقول إن المجاني "should be avoided for production workloads where uninterrupted availability matters" — https://neon.com/docs/get-started/production-checklist

### Hyperdrive (بديل محتمل للاتصال) — https://developers.cloudflare.com/hyperdrive/platform/pricing/
- متاح على الخطة المجانية: 100,000 استعلام/يوم. Neon يوصي به الآن مع Workers (https://neon.com/docs/guides/cloudflare-workers).

### GitHub Actions — https://docs.github.com/en/billing/concepts/product-billing/github-actions
- المستودع الخاص على الخطة المجانية: 2,000 دقيقة/شهر و 500 ميجا تخزين.

### ملاحظة على المحوّل
- Cloudflare توصي الآن بـ **vinext** (تجريبي beta) للتطبيقات الجديدة بدل OpenNext. OpenNext (1.20.12) ما زال مدعومًا ويدعم Next.js 16. **الاختيار: OpenNext** كما في الخطة المعتمدة، لأن vinext ما زال تجريبيًا.

---

## A-02 — Next.js على Workers

| القياس | القيمة |
|---|---|
| الإصدارات | Next.js 16.4.2، @opennextjs/cloudflare 1.20.12، wrangler 4.151.1 |
| حجم الـ Worker | 5.3 ميجا غير مضغوط / 1.1 ميجا gzip (الحد 64 ميجا) |
| الصفحة على workerd محليًا | 200، ~0.2 ثانية بعد الإحماء، RTL واسم المنشأة من القاعدة |
| Server Action على workerd محليًا | ✅ (اختبار Playwright على المعاينة المحلية) |
| النشر الفعلي | ⏳ بانتظار `wrangler login` |

**مشكلة اكتُشفت وحُلّت:** مع `cacheComponents: true` (افتراضي Next.js 16.4) يعلق الطلب على workerd ويلغيه الـ runtime (500)، مع تحذير من Next بأن Cache Components لا تضمن العمل مع تنفيذ `setTimeout()` في هذا الـ runtime. بعد تعطيلها يعمل كل شيء. النظام داخلي وكل صفحاته ديناميكية خلف تسجيل الدخول، فلا خسارة وظيفية.

## A-03 — تشفير كلمة المرور

- مصدر: workerd يحدد PBKDF2 بـ **100,000 تكرار كحد أقصى** في الإنتاج (`DEFAULT_MAX_PBKDF2_ITERATIONS = 100'000` في `src/workerd/io/limit-enforcer.h`)، والتجاوز يرمي خطأ في الإنتاج فقط. توصية OWASP لـ PBKDF2-SHA256 هي 600 ألف.
- قياس محلي (Node، نفس نوع التنفيذ الأصلي):

| التكرارات | CPU لكل اشتقاق |
|---|---|
| 10,000 | ~4.7 مللي ثانية |
| 50,000 | ~12.6 مللي ثانية |
| 100,000 | ~28.1 مللي ثانية |

- ⏳ القياس الفعلي: endpoint محمي بتوكن على الـ Worker المنشور، مع عدّ أخطاء 1102 تحت تكرار الطلبات، وقراءة CPU من Workers Logs.

## A-04 — قيد منع التعارض

اختبارات تكامل على PostgreSQL 17 حقيقي بنفس SQL الموجود في DATA_MODEL (6 حالات، كلها ناجحة): تداخل جزئي مرفوض؛ داخل الوقت الفاصل مرفوض؛ متلاصق `[)` مسموح؛ أماكن مختلفة مسموح؛ المبدئي والملغي لا يتأثران؛ تأكيد مبدئي على موعد محجوز مرفوض. ⏳ تشغيل نفس الاختبارات على Neon.

## A-05 — Transaction

- محليًا (Node + workerd) عبر driver Neon (WebSocket Pool) و wsproxy: إدراج ثم إدراج فاشل (23505) ← الأول أُلغي، والقراءة داخل الـ Transaction ترى الإدراج (تفاعلية فعلًا). ✅
- ⏳ على Workers + Neon الفعليين.

---

## انحرافات وملاحظات تقنية

1. **تعطيل Cache Components** في Next.js (انظر A-02). لا يغير الستاك.
2. **اتصال قاعدة البيانات:** اتصال WebSocket لكل طلب ويُغلق بعد الاستجابة (`after()`)، حسب توجيه Neon و OpenNext. محليًا تظهر رسالة مسجّلة "Network connection lost" عند إغلاق الاتصال بعد Server Action — الطلبات ناجحة؛ يُعاد فحصها على Neon الفعلي.
3. **ثغرات `npm audit`:** 13 (متوسطة/عالية) كلها في أدوات التطوير (drizzle-kit، OpenNext)، و**صفر** في حزم الإنتاج.
4. **endpoint فحص القاعدة (Server Action) و endpoints التجارب** مؤقتة وبلا جلسة عن قصد، وتُزال في المرحلة 1 / بعد القياس.
