import { z } from "zod";
import { id, listName, optionalIntField, timeField } from "@/modules/shared/fields";

const slot = z.object({ start: timeField, end: timeField });

/** Every space is created with both slots (BR-01); BR-02 is checked by the service. */
const spaceFields = {
  name: listName,
  capacityMax: optionalIntField(1, 100_000),
  day: slot,
  evening: slot,
};

export const createSpaceSchema = z.object(spaceFields);
export const updateSpaceSchema = z.object({ spaceId: id, ...spaceFields });
export const setSpaceActiveSchema = z.object({ spaceId: id, active: z.boolean() });
export const moveSpaceSchema = z.object({ spaceId: id, direction: z.enum(["up", "down"]) });
