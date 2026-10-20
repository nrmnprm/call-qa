/** Red flags found by plain rules. They do not depend on the model, so a
 * policy breach is caught even when the model misses it or is unavailable,
 * and a rule hit overrides a model that scored compliance as fine. */
import type { RedFlag, Transcript } from './types.ts'

/** Sales managers may give up to this discount without approval. */
export const DISCOUNT_LIMIT = 5

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, 'twenty-five': 25, thirty: 30, forty: 40, fifty: 50,
  один: 1, два: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, пятнадцать: 15, двадцать: 20, тридцать: 30,
}

/** Percentages mentioned in a sentence: "15%", "fifteen percent", "10 процентов". */
export function percentages(text: string): number[] {
  const out: number[] = []
  const re = /([\p{L}\d-]+)\s*(%|percent\b|per cent\b|процент\w*)/giu
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const w = m[1].toLowerCase()
    const n = /^\d+(\.\d+)?$/.test(w) ? Number(w) : NUMBER_WORDS[w]
    if (n != null) out.push(n)
  }
  return out
}

const DISCOUNT_CONTEXT = /\b(off|discount|cheaper|reduce)\b|скидк|дешевле/i
/** The manager is asking for approval rather than granting the discount. */
const APPROVAL_CONTEXT = /\b(approv\w*|ask (my|our) (head|manager|director)|head of sales|can'?t promise|check with)\b|согласова\w*|руководител\w*|не могу обещать/i
const GUARANTEE = /\b(guarantee\w*|I promise|promise you|definitely (be|arrive|deliver)|no problem)\b|гарантир\w*|обещаю|точно (привез|будет|доставим)/i
const DELIVERY = /\b(deliver\w*|ship\w*|arriv\w*|by (monday|tuesday|wednesday|thursday|friday)|tomorrow)\b|доставк\w*|привез\w*|отгруз\w*|завтра/i

export function ruleFlags(t: Transcript): RedFlag[] {
  const flags: RedFlag[] = []
  const us = t.utterances
  us.forEach((u, i) => {
    if (u.role !== 'manager') return
    const prev = us[i - 1]
    const over = percentages(u.text).filter((p) => p > DISCOUNT_LIMIT && p < 100)
    if (over.length && DISCOUNT_CONTEXT.test(u.text) && !APPROVAL_CONTEXT.test(u.text)) {
      flags.push({ type: 'unapproved_discount', utterance: u.id, note: `offers ${Math.max(...over)}% without approval (limit ${DISCOUNT_LIMIT}%)`, source: 'rules' })
    }
    // "Friday is no problem, I guarantee it" answers the customer's delivery question.
    if (GUARANTEE.test(u.text) && (DELIVERY.test(u.text) || (prev?.role === 'customer' && DELIVERY.test(prev.text)))) {
      flags.push({ type: 'delivery_promise', utterance: u.id, note: 'guarantees a delivery date', source: 'rules' })
    }
  })
  const card = t.redactions.find((r) => r.kind === 'card number')
  if (card) {
    flags.push({ type: 'payment_data', utterance: card.utterance, note: 'card details were read out on the call (masked before analysis)', source: 'rules' })
  }
  return flags
}
