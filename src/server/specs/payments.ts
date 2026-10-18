import { getReceipt, listCollections } from "@/modules/payments/queries";
import {
  collectionsSchema,
  paymentIdSchema,
  recordDepositSchema,
  recordPaymentSchema,
  setInstallmentsSchema,
  voidPaymentSchema,
} from "@/modules/payments/schemas";
import { recordDeposit, recordPayment, setInstallments, voidPayment } from "@/modules/payments/service";
import { defineProtected } from "./define";

/** API.md "Payments" (phase 6, D-118..D-126). `payments.refund` comes with phases 7/8. */
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
