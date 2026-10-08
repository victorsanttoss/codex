import { fetchHttpClient, type HttpClient } from "@sdr/whatsapp-cloud";

/** Token DI do cliente HTTP do WhatsApp — sobrescrevível em teste (Meta mockada). */
export const WHATSAPP_HTTP = "WHATSAPP_HTTP";

export const whatsappHttpProvider = {
  provide: WHATSAPP_HTTP,
  useValue: fetchHttpClient as HttpClient,
};
