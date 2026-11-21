/**
 * Roman Hinglish → Devanagari, for the voice only. The screen keeps the
 * Roman Hinglish the user writes; the natural voice (Kokoro) reads Hindi
 * correctly only from Devanagari (round-trip test: "khol diya" in Roman came
 * back as "call diya", in Devanagari as "khol diya"). Common Hinglish words
 * are converted from a dictionary; English and unknown words stay in Roman
 * letters and are read as English. Pure code.
 */
const WORDS: Readonly<Record<string, string>> = {
  // Pronouns, people
  main: 'मैं', mai: 'मैं', mein: 'में', me: 'में', mujhe: 'मुझे', mujhse: 'मुझसे', mera: 'मेरा', meri: 'मेरी', mere: 'मेरे',
  hum: 'हम', humein: 'हमें', hamara: 'हमारा', hamari: 'हमारी', tum: 'तुम', tumhe: 'तुम्हें', tumhara: 'तुम्हारा', tumhari: 'तुम्हारी',
  aap: 'आप', aapko: 'आपको', aapka: 'आपका', aapki: 'आपकी', aapke: 'आपके', aapse: 'आपसे', ye: 'ये', yeh: 'यह', yah: 'यह',
  wo: 'वो', woh: 'वो', vo: 'वो', us: 'उस', usko: 'उसको', uska: 'उसका', uski: 'उसकी', unka: 'उनका', isko: 'इसको', iska: 'इसका',
  iski: 'इसकी', iske: 'इसके', is: 'इस', in: 'इन', sab: 'सब', sabhi: 'सभी', koi: 'कोई', kuch: 'कुछ', kuchh: 'कुछ',
  ji: 'जी', bhai: 'भाई', bhaiya: 'भैया', sir: 'सर', dost: 'दोस्त',
  // Verbs (common forms)
  hai: 'है', hain: 'हैं', hoon: 'हूँ', hun: 'हूँ', ho: 'हो', tha: 'था', thi: 'थी', the: 'थे', hoga: 'होगा', hogi: 'होगी',
  hua: 'हुआ', hui: 'हुई', hue: 'हुए', gaya: 'गया', gayi: 'गई', gaye: 'गए', diya: 'दिया', di: 'दी', diye: 'दिए', liya: 'लिया', li: 'ली',
  kar: 'कर', karo: 'करो', karna: 'करना', karke: 'करके', karta: 'करता', karti: 'करती', karte: 'करते', karunga: 'करूँगा', karungi: 'करूँगी',
  kiya: 'किया', kijiye: 'कीजिए', kariye: 'करिए', de: 'दे', do: 'दो', dena: 'देना', dijiye: 'दीजिए', dunga: 'दूँगा', dungi: 'दूँगी',
  le: 'ले', lo: 'लो', lena: 'लेना', lijiye: 'लीजिए', raha: 'रहा', rahi: 'रही', rahe: 'रहे', rakh: 'रख', rakha: 'रखा',
  khol: 'खोल', kholo: 'खोलो', kholna: 'खोलना', khula: 'खुला', khuli: 'खुली', band: 'बंद', chal: 'चल', chala: 'चला', chalao: 'चलाओ',
  chalana: 'चलाना', chalu: 'चालू', dekh: 'देख', dekho: 'देखो', dekha: 'देखा', dekhiye: 'देखिए', bata: 'बता', batao: 'बताओ',
  bataiye: 'बताइए', bataya: 'बताया', bol: 'बोल', bolo: 'बोलो', bola: 'बोला', suno: 'सुनो', suna: 'सुना', samjha: 'समझा',
  samjhi: 'समझी', samajh: 'समझ', chahiye: 'चाहिए', chahte: 'चाहते', chahti: 'चाहती', sakta: 'सकता', sakti: 'सकती', sakte: 'सकते',
  mil: 'मिल', mila: 'मिला', mili: 'मिली', laga: 'लगा', lagi: 'लगी', lag: 'लग', ruk: 'रुक', ruko: 'रुको', jao: 'जाओ', ja: 'जा',
  jaa: 'जा', aa: 'आ', aaya: 'आया', aayi: 'आई', aaye: 'आए', ho_gaya: 'हो गया', bana: 'बना', banaya: 'बनाया', banao: 'बनाओ',
  likh: 'लिख', likha: 'लिखा', likho: 'लिखो', padh: 'पढ़', padha: 'पढ़ा', dhoondh: 'ढूँढ', dhundh: 'ढूँढ', dhoondha: 'ढूँढा',
  bhej: 'भेज', bheja: 'भेजा', bhejo: 'भेजो', soch: 'सोच', socha: 'सोचा', badal: 'बदल', badla: 'बदला', hata: 'हटा', hataya: 'हटाया',
  // Small words
  aur: 'और', ya: 'या', ki: 'की', ka: 'का', ke: 'के', ko: 'को', se: 'से', par: 'पर', pe: 'पे', tak: 'तक', bhi: 'भी', to: 'तो',
  toh: 'तो', hi: 'ही', na: 'ना', nahi: 'नहीं', nahin: 'नहीं', mat: 'मत', haan: 'हाँ', han: 'हाँ', ha: 'हाँ', jee: 'जी',
  kya: 'क्या', kyun: 'क्यों', kyon: 'क्यों', kaise: 'कैसे', kaisa: 'कैसा', kaisi: 'कैसी', kab: 'कब', kahan: 'कहाँ', kaun: 'कौन',
  kitna: 'कितना', kitni: 'कितनी', kitne: 'कितने', jab: 'जब', tab: 'तब', agar: 'अगर', lekin: 'लेकिन', magar: 'मगर', phir: 'फिर',
  fir: 'फिर', abhi: 'अभी', ab: 'अब', aaj: 'आज', kal: 'कल', parso: 'परसों', yahan: 'यहाँ', wahan: 'वहाँ', bas: 'बस', sirf: 'सिर्फ़',
  bahut: 'बहुत', thoda: 'थोड़ा', thodi: 'थोड़ी', zyada: 'ज़्यादा', jyada: 'ज़्यादा', kam: 'कम', sahi: 'सही', galat: 'ग़लत',
  theek: 'ठीक', thik: 'ठीक', accha: 'अच्छा', acha: 'अच्छा', achha: 'अच्छा', achchha: 'अच्छा', badhiya: 'बढ़िया', mast: 'मस्त',
  shukriya: 'शुक्रिया', dhanyavaad: 'धन्यवाद', namaste: 'नमस्ते', arey: 'अरे', are: 'अरे', arre: 'अरे', chaliye: 'चलिए', chalo: 'चलो',
  ek: 'एक', do_: 'दो', teen: 'तीन', char: 'चार', paanch: 'पाँच', pehle: 'पहले', baad: 'बाद', saath: 'साथ', bina: 'बिना',
  liye: 'लिए', wala: 'वाला', wali: 'वाली', wale: 'वाले', jaisa: 'जैसा', jaise: 'जैसे', taiyaar: 'तैयार', tayyar: 'तैयार',
  kaam: 'काम', baat: 'बात', din: 'दिन', raat: 'रात', samay: 'समय', waqt: 'वक़्त', ghanta: 'घंटा', minute_: 'मिनट',
  mausam: 'मौसम', ghar: 'घर', paisa: 'पैसा', paise: 'पैसे', hazaar: 'हज़ार', hazar: 'हज़ार', lakh: 'लाख', rupaye: 'रुपये',
  dukaan: 'दुकान', dukan: 'दुकान', gaana: 'गाना', gana: 'गाना', khana: 'खाना', paani: 'पानी', safar: 'सफ़र', yatra: 'यात्रा',
  khoj: 'खोज', jawab: 'जवाब', sawaal: 'सवाल', sawal: 'सवाल', madad: 'मदद', zaroor: 'ज़रूर', jaroor: 'ज़रूर', bilkul: 'बिल्कुल',
  shayad: 'शायद', pakka: 'पक्का', dobara: 'दोबारा', fir_se: 'फिर से', aage: 'आगे', peeche: 'पीछे', upar: 'ऊपर', neeche: 'नीचे',
};

/** Words that read the same in English and Hinglish but mean the English word in a mixed sentence. */
const ENGLISH_HOMOGRAPHS = new Set(['the', 'is', 'in', 'to', 'do', 'me', 'are', 'us', 'hi', 'ha', 'par', 'band', 'char', 'kal', 'pe', 'na']);

function convertWord(word: string, englishContext: boolean): string {
  const lower = word.toLowerCase();
  const devanagari = WORDS[lower];
  if (devanagari === undefined) return word;
  // In a mostly English sentence, "is", "do", "the" are English words.
  if (englishContext && ENGLISH_HOMOGRAPHS.has(lower)) return word;
  return devanagari;
}

/** How much of the text is known Hinglish (0–1). */
function hinglishShare(words: readonly string[]): number {
  if (words.length === 0) return 0;
  const known = words.filter(word => WORDS[word.toLowerCase()] !== undefined && !ENGLISH_HOMOGRAPHS.has(word.toLowerCase())).length;
  return known / words.length;
}

/**
 * Rewrite Roman Hinglish for the voice: known Hindi words in Devanagari,
 * English and unknown words unchanged. A sentence with no Hinglish signal
 * (plain English) is returned as it is.
 */
export function hinglishForVoice(text: string): string {
  return text.split(/(?<=[.!?।\n])/u).map(sentence => {
    const words = sentence.match(/[A-Za-z]+(?:'[A-Za-z]+)?/gu) ?? [];
    const share = hinglishShare(words);
    if (share < 0.2) return sentence; // English sentence
    const englishContext = share < 0.4;
    return sentence.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/gu, word => convertWord(word, englishContext));
  }).join('');
}
