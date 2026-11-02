export type AssistantRequest = 'start' | 'status' | 'unsupported';

// Núcleo determinista: sin SDKs, credenciales, llamadas de red ni efectos financieros.
export function respondToMessage(request: AssistantRequest): string {
  switch (request) {
    case 'start':
      return 'Hola, soy Jarvis. Ya puedo recibir tus mensajes de texto. Usa /status para consultar mi estado. Las funciones financieras todavía están pendientes.';
    case 'status':
      return 'Jarvis activo (Fase 1A). IA: deshabilitada. Finanzas y persistencia: pendientes. Todavía no registro operaciones.';
    case 'unsupported':
      return 'Todavía no tengo esa función. Puedes usar /start o /status. No he registrado ninguna operación.';
  }
}
