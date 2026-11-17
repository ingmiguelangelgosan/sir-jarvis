import { createHmac } from 'node:crypto';
import { recordInputSchema } from '../../agents/finance-expense-profile.ts';
import type { ExpenseConfirmationService } from '../../app/expense-confirmation.ts';
import type { Confirmation } from '../../app/confirmation-store.ts';
import type { TelegramAgentMessage } from './agent-commands.ts';

export interface ExpenseConversation {
  matches(text: string): boolean;
  handle(message: TelegramAgentMessage, signal: AbortSignal): Promise<string>;
}

export function renderConfirmation(row: Confirmation): string {
  const summary = `${row.draft.amount} COP en ${row.draft.label}, fecha ${row.draft.occurredOn}`;
  switch (row.state) {
    case 'awaiting_confirmation':
      return `¿Confirmas registrar ${summary}? Referencia ${row.reference}. Responde «sí ${row.reference}» o «cancelar ${row.reference}». Vigencia: 5 minutos.`;
    case 'cancelled':
      return row.reason === 'expired'
        ? 'La solicitud caducó. No envié el gasto.'
        : 'Solicitud cancelada o reemplazada antes de ejecutar.';
    case 'executing':
      return 'La operación está en ejecución. No la registraré de nuevo.';
    case 'completed':
      return `Listo, registré ${summary}. Referencia ${row.reference}.`;
    case 'uncertain':
      return row.evidence
        ? `Encontré el gasto registrado: ${summary}. El flujo sigue pendiente de conciliación con Jarvis; no lo registraré otra vez.`
        : `Aún no tengo evidencia suficiente para confirmar el resultado. No puedo asegurar que no se haya registrado. Consulta ${row.reference}; no repetiré la escritura.`;
    case 'failed':
      return 'La operación fue rechazada de forma definitiva. No la repetiré automáticamente.';
  }
}

/** Explicit test composition only: never installed by the operational loader. */
export function createExpenseConversation(options: {
  instanceId: string;
  actionKey: string;
  // Called on every message, including state/evidence queries; supports revocation.
  subjectFor(userId: number): string | undefined;
  categories: readonly {
    subjectRef: string;
    alias: string;
    categoryId: string;
    label: string;
  }[];
  service: ExpenseConfirmationService;
}): ExpenseConversation {
  const key = Buffer.from(options.actionKey, 'base64url');
  if (key.length < 32 || key.length > 64)
    throw new Error('Invalid conversation key');
  const instanceId = options.instanceId;
  const categories = options.categories.map((entry) =>
    Object.freeze({ ...entry }),
  );
  const hash = (value: unknown) =>
    createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
  return {
    matches(text) {
      return /^(?:\/gasto(?:@[A-Za-z0-9_]+)?(?:\s|$)|(?:Jarvis,\s*)?gast[eé](?:\s|$)|s[ií](?:\s|$)|cancelar(?:\s|$)|consultar(?:\s|$)|pendientes$)/i.test(
        text.trim(),
      );
    },
    async handle(message, signal) {
      if (signal.aborted)
        return 'Consulta cancelada; no confirma reversión financiera.';
      const subject = options.subjectFor(message.userId);
      if (!subject || message.chatId !== message.userId || !message.botId)
        return 'No tienes un perfil financiero autorizado.';
      const scope = {
        instance_id: instanceId,
        subject_ref: subject,
        conversation_ref: hash([
          'conversation',
          instanceId,
          subject,
          message.botId,
          message.chatId,
        ]),
      };
      const source = hash([
        'consent-source',
        instanceId,
        subject,
        message.botId,
        message.chatId,
        message.messageId,
      ]);
      const text = message.text.trim();
      try {
        if (/^s[ií]$/i.test(text)) {
          options.service.pending(scope); // Reauthorize even for a clarification.
          return 'Indica la referencia exacta: sí G-…';
        }
        if (/^pendientes$/i.test(text)) {
          const pending = options.service.pending(scope);
          return pending
            ? renderConfirmation(pending)
            : 'No hay una solicitud pendiente.';
        }
        const action = /^(s[ií]|cancelar|consultar) (G-[a-f0-9]{12})$/i.exec(
          text,
        );
        if (action) {
          const reference = `G-${action[2]!.slice(2).toLowerCase()}`;
          const row = /^s/i.test(action[1]!)
            ? await options.service.confirm(scope, reference, source, signal)
            : action[1]!.toLowerCase() === 'cancelar'
              ? options.service.cancel(scope, reference, source)
              : await options.service.recover(scope, reference, source, signal);
          return renderConfirmation(row);
        }
        if (/^(s[ií]|cancelar|consultar)\b/i.test(text))
          return 'Referencia inválida. Usa la referencia completa de la solicitud.';
        const command =
          /^\/gasto(?:@[A-Za-z0-9_]+)?(?:\s+(\S+))?(?:\s+COP)?(?:\s+([^\d]+?))?(?:\s+(\d{4}-\d{2}-\d{2}))?$/i.exec(
            text,
          );
        const phrase =
          /^(?:Jarvis,\s*)?gast[eé](?:\s+\$?([0-9.]+))?(?:\s+en\s+(.+?))?(?:\s+el\s+(\d{4}-\d{2}-\d{2}))?$/i.exec(
            text,
          );
        const parsed = command ?? phrase;
        if (!parsed)
          return 'Usa /gasto <importe decimal> COP gasolina <AAAA-MM-DD>.';
        if (!parsed[1]) return '¿Qué importe en COP quieres registrar?';
        let amount = parsed[1];
        if (!command) {
          if (!/^(?:[1-9][0-9]*|[1-9][0-9]{0,2}(?:\.[0-9]{3})+)$/.test(amount))
            return 'Importe ambiguo. Usa /gasto con importe decimal exacto.';
          amount = amount.replaceAll('.', '');
        }
        const alias = parsed[2]?.trim().toLowerCase();
        const matches = categories.filter(
          (entry) => entry.subjectRef === subject && entry.alias === alias,
        );
        if (matches.length !== 1)
          return 'Indica una categoría sintética autorizada sin ambigüedad: gasolina.';
        if (!parsed[3])
          return 'Indica la fecha civil explícita: AAAA-MM-DD. No asumiré hoy.';
        const category = matches[0]!;
        const draft = {
          ...recordInputSchema.parse({
            amount,
            currency: 'COP',
            categoryId: category.categoryId,
            occurredOn: parsed[3],
          }),
          label: category.label,
        };
        return renderConfirmation(
          options.service.prepare(scope, draft, source),
        );
      } catch {
        return 'No puedo aceptar esa operación o referencia con los permisos y datos actuales. No iniciaré otra escritura.';
      }
    },
  };
}
