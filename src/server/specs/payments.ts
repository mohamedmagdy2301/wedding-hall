import { getReceipt, listCollections } from "@/modules/payments/queries";
import {
  collectionsSchema,
  paymentIdSchema,
  recordDepositSchema,
  recordPaymentSchema,
  refundSchema,
  setInstallmentsSchema,
  voidPaymentSchema,
} from "@/modules/payments/schemas";
import { recordDeposit, recordPayment, refundCredit, setInstallments, voidPayment } from "@/modules/payments/service";
import { defineProtected } from "./define";

/** API.md "Payments" (phases 6 and 7, D-118..D-126, D-131). */
export const paymentSpecs = {
  record: defineProtected({
    schema: recordPaymentSchema,
    requires: "payments.record",
    handler: (ctx, input) => recordPayment(ctx, ctx.actor, input),
  }),
  recordDeposit: defineProtected({
    schema: recordDepositSchema,
    requires: "payments.record",
    handler: (ctx, input) => recordDeposit(ctx, ctx.actor, input),
  }),
  void: defineProtected({
    schema: voidPaymentSchema,
    requires: "payments.void",
    handler: (ctx, input) => voidPayment(ctx, ctx.actor, input),
  }),
  refund: defineProtected({
    schema: refundSchema,
    requires: "payments.refund",
    handler: (ctx, input) => refundCredit(ctx, ctx.actor, input),
  }),
  setInstallments: defineProtected({
    schema: setInstallmentsSchema,
    requires: "payments.record",
    handler: (ctx, input) => setInstallments(ctx, ctx.actor, input),
  }),
  receipt: defineProtected({
    schema: paymentIdSchema,
    requires: "bookings.view",
    handler: (ctx, input) => getReceipt(ctx.db, ctx.actor, input.paymentId),
  }),
  collections: defineProtected({
    schema: collectionsSchema,
    requires: "payments.record",
    handler: (ctx, input) => listCollections(ctx.db, ctx.actor, input, ctx.now),
  }),
};
