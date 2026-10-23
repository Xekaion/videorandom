function explicitTranslationRefusal(text) {
    const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    // Recognize explicit responses about performing this translation task;
    // ordinary dialogue such as "도와줄 수 없다" is not a service refusal.
    // A scoped prefix must start at a token boundary: the subject suffix in
    // "둘이 번역할 수 없어" is not the standalone task reference "이".
    return /(?<![\p{L}\p{N}_])(?:이|해당|이러한|요청하신|제공된)\s*(?:요청|콘텐츠|내용|대사|자료|텍스트)?(?:의|에\s*대한|은|는|를|을)?\s*(?:번역|자막(?:\s*번역)?)(?:을|은|는)?\s*(?:(?:제공|수행|진행|생성|지원)(?:해\s*드릴|할)?|해\s*드릴|도와\s*드릴|해줄|할)\s*수\s*없/u.test(normalized)
        || /(?<![\p{L}\p{N}_])(?:이|해당|요청하신)\s*(?:요청|작업)(?:을|은|는)?\s*(?:도와\s*드릴|도와줄|수행할|처리할|진행할|지원할)\s*수\s*없/u.test(normalized)
        || /정책(?:상|에\s*따라|으로(?:\s*인해)?).{0,100}(?:번역|자막).{0,60}(?:불가|(?:제공할|지원할|할|드릴)\s*수\s*없)/.test(normalized)
        || /\b(?:i|we)\s+(?:cannot|can['’]?t|am unable to|are unable to)\s+(?:provide|perform|generate|assist with)\s+(?:(?:a|the|this|that|requested)\s+)*(?:translation|subtitles?|translating)\b/i.test(normalized);
}

module.exports = { explicitTranslationRefusal };
