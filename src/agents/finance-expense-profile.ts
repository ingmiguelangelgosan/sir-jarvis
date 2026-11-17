import { z } from 'zod';
import {
  identifierSchema,
  type PayloadSchemaDefinition,
} from './validation.ts';

// Protocol validation only; the external financial agent owns all calculations.
const civilDate = z
  .string()
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  });
const decimal = z
  .string()
  .max(4097)
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/)
  .refine((value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    const minor = (whole + fraction.padEnd(2, '0')).replace(/^0+/, '');
    return minor.length > 0 && minor.length <= 4096;
  });
export const recordInputSchema = z.strictObject({
  amount: decimal,
  currency: z.literal('COP'),
  categoryId: identifierSchema,
  occurredOn: civilDate,
});
export const lookupInputSchema = z.strictObject({
  write_intent_id: identifierSchema,
});
export const expenseSchema = z.strictObject({
  id: identifierSchema,
  amount: z.strictObject({
    minor: z
      .string()
      .max(4096)
      .regex(/^[1-9][0-9]*$/),
    currency: z.literal('COP'),
  }),
  categoryId: identifierSchema,
  occurredOn: civilDate,
});
export const financeExpenseSchemas: readonly PayloadSchemaDefinition[] = [
  { id: 'finance.expense.record.input.v1', schema: recordInputSchema },
  {
    id: 'finance.expense.record.output.v1',
    schema: z.strictObject({ expense: expenseSchema }),
  },
  { id: 'finance.expense.lookup.input.v1', schema: lookupInputSchema },
  {
    id: 'finance.expense.lookup.output.v1',
    schema: z.union([
      z.strictObject({ found: z.literal(false) }),
      z.strictObject({ found: z.literal(true), expense: expenseSchema }),
    ]),
  },
];
