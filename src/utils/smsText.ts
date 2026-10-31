/** Texts sent to patients, in English and Swahili. Keep them short: one SMS is about 160 characters. */
export type Lang = "en" | "sw";
export const asLang = (v: unknown): Lang => (v === "sw" ? "sw" : "en");

type V = Record<string, string | number>;
const T: Record<string, Record<Lang, (v: V) => string>> = {
  otp: {
    en: (v) => `Lisa Hospitals: your booking code is ${v.code}. It expires in ${v.mins} minutes.`,
    sw: (v) => `Lisa Hospitals: nambari yako ya kuthibitisha ni ${v.code}. Inaisha baada ya dakika ${v.mins}.`,
  },
  booked: {
    en: (v) => `Lisa Hospitals: ${v.firm ? "booked" : "request received"} ${v.when} with ${v.doctor}. Ref ${v.ref}.${v.link ? ` Change or cancel: ${v.link}` : ""}`,
    sw: (v) => `Lisa Hospitals: ${v.firm ? "umepangiwa" : "ombi lako limepokelewa"} ${v.when} na ${v.doctor}. Nambari ${v.ref}.${v.link ? ` Badilisha au ghairi: ${v.link}` : ""}`,
  },
  moved: {
    en: (v) => `Lisa Hospitals: your appointment is now ${v.when} with ${v.doctor}. Ref ${v.ref}.`,
    sw: (v) => `Lisa Hospitals: miadi yako sasa ni ${v.when} na ${v.doctor}. Nambari ${v.ref}.`,
  },
  cancelled: {
    en: (v) => `Lisa Hospitals: your appointment on ${v.when} was cancelled. Please call us or rebook online. Ref ${v.ref}.`,
    sw: (v) => `Lisa Hospitals: miadi yako ya ${v.when} imeghairiwa. Tafadhali tupigie au upange tena mtandaoni. Nambari ${v.ref}.`,
  },
  missed: {
    en: (v) => `Lisa Hospitals: we missed you at your appointment on ${v.when}. If you still need to be seen, rebook at ${v.link} or call ${v.phone}.`,
    sw: (v) => `Lisa Hospitals: hatukukuona kwenye miadi yako ya ${v.when}. Ikiwa bado unahitaji huduma, panga tena ${v.link} au piga ${v.phone}.`,
  },
};

export const smsText = (key: keyof typeof T, lang: unknown, v: V = {}) => T[key][asLang(lang)](v);

/** "Fri, 30 Oct 12:30" in the patient's language. */
export function whenText(date: string, time: string, lang: unknown) {
  const d = new Date(`${date}T00:00:00Z`).toLocaleDateString(asLang(lang) === "sw" ? "sw-KE" : "en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return `${d} ${time.slice(0, 5)}`;
}
