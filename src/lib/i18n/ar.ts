// All UI strings live here so they can be translated later (D-04).
export const ar = {
  app: {
    name: "نظام إدارة قاعات الأفراح",
    description: "نظام داخلي لإدارة الحجوزات والمدفوعات والتقارير",
  },
  home: {
    venueLabel: "المنشأة",
    venueLoading: "جارِ تحميل بيانات المنشأة…",
    venueMissing: "لم تُجهّز المنشأة بعد",
  },
  dbCheck: {
    title: "فحص الاتصال بقاعدة البيانات",
    submit: "افحص الآن",
    pending: "جارِ الفحص…",
    ok: "الاتصال يعمل",
    failed: "تعذّر الاتصال بقاعدة البيانات",
    serverTime: "وقت الخادم",
  },
} as const;

export type Messages = typeof ar;
