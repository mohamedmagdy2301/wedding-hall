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
  errors: {
    /** Fallback message per error code (API.md). */
    codes: {
      UNAUTHENTICATED: "انتهت الجلسة. سجّل الدخول من جديد.",
      FORBIDDEN: "لا تملك صلاحية لهذه العملية.",
      VALIDATION_ERROR: "راجع البيانات المدخلة.",
      NOT_FOUND: "العنصر غير موجود.",
      CONFLICT_SLOT_TAKEN: "الموعد محجوز.",
      CONCURRENT_MODIFICATION: "عدّل موظف آخر هذه البيانات. حدّث الصفحة وأعد المحاولة.",
      BUSINESS_RULE_VIOLATION: "العملية تخالف قواعد العمل.",
      INTERNAL_ERROR: "حدث خطأ غير متوقع. حاول مرة أخرى.",
    },
    /** Message keys used by services and Zod schemas. */
    messages: {
      forbidden: "لا تملك صلاحية لهذه العملية.",
      notFound: "العنصر غير موجود.",
      validation: "راجع البيانات المدخلة.",
      sessionExpired: "انتهت الجلسة. سجّل الدخول من جديد.",
      passwordChangeRequired: "يجب تغيير كلمة المرور المؤقتة أولًا.",
      loginFailed: "تعذّر تسجيل الدخول. تأكد من البيانات، أو حاول بعد قليل إن تكررت المحاولات.",
      required: "هذا الحقل مطلوب.",
      tooLong: "النص أطول من المسموح.",
      invalidId: "معرّف غير صالح.",
      loginInvalid: "اكتب رقم موبايل مصري صحيح، أو اسم مستخدم من 3 إلى 32 حرفًا إنجليزيًا أو رقمًا أو . _ -",
      loginTaken: "اسم الدخول مستخدم لموظف آخر.",
      passwordTooShort: "كلمة المرور 8 أحرف على الأقل.",
      passwordTooLong: "كلمة المرور أطول من المسموح (128 حرفًا).",
      passwordMismatch: "كلمتا المرور غير متطابقتين.",
      passwordUnchanged: "اختر كلمة مرور مختلفة عن الحالية.",
      currentPasswordWrong: "كلمة المرور الحالية غير صحيحة.",
      userNotFound: "الموظف غير موجود.",
      roleNotFound: "الدور غير موجود.",
      roleNameTaken: "يوجد دور بنفس الاسم.",
      roleInUse: "لا يمكن حذف دور عليه موظفون. انقلهم لدور آخر أولًا.",
      permissionUnknown: "صلاحية غير معروفة.",
      cannotGrantPermissions: "لا يمكنك منح صلاحيات لا تملكها.",
      ownerAccountProtected: "لا يعدّل حساب المالك إلا مالك.",
      ownerCannotBeDeactivated: "لا يمكن تعطيل المالك.",
      ownerLoginProtected: "لا يغيّر اسم دخول المالك إلا المالك نفسه.",
      ownerPasswordProtected:
        "لا تُعاد كلمة مرور المالك من هنا. المالك يغيّرها بنفسه، وإن نسيها تُعاد بسكريبت الدعم الفني.",
      inactiveCannotBeOwner: "فعّل الموظف أولًا قبل جعله مالكًا.",
      lastOwner: "يجب أن يبقى مالك نشط واحد على الأقل.",
      notAnOwner: "هذا الحساب ليس مالكًا.",
      venueNotSetUp: "المنشأة لم تُجهّز بعد.",
      venueAlreadySetUp: "المنشأة مُجهّزة بالفعل.",
    },
  },
} as const;

export type Messages = typeof ar;
