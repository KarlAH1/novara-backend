const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PITCH_TEXT_MAX_LENGTH = 500;

const SYSTEM_PROMPT = `Du er en erfaren norsk tekstforfatter som hjelper startup-gründere skrive korte, tydelige og selgende pitch-tekster til investorer.
Du får to tekstfelt en gründer har skrevet selv: "Hva selskapet tilbyr" og "Hva pengene skal brukes til".
Skriv en forbedret versjon av hvert felt: klarere språk, mer profesjonelt og mer overbevisende.
Behold alle faktiske opplysninger brukeren har gitt. Ikke finn på nye funksjoner, tall, kunder eller påstander som ikke allerede står i originalteksten.
Hvert felt skal være maks ${PITCH_TEXT_MAX_LENGTH} tegn.
Svar KUN med gyldig JSON på nøyaktig dette formatet, uten noe annen tekst før eller etter: {"what_offers": "...", "use_of_funds": "..."}`;

export async function improveStartupPitchText({ whatOffers, useOfFunds }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return null;
    }

    const userPrompt = JSON.stringify({
        what_offers: whatOffers || "",
        use_of_funds: useOfFunds || ""
    });

    const response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userPrompt }
            ],
            response_format: { type: "json_object" },
            temperature: 0.6,
            max_tokens: 600
        })
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`OpenAI API error (${response.status}): ${errorText.slice(0, 300)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error("OpenAI returnerte ikke noe innhold.");
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error("Kunne ikke tolke svaret fra OpenAI.");
    }

    return {
        whatOffers: String(parsed.what_offers || "").trim().slice(0, PITCH_TEXT_MAX_LENGTH),
        useOfFunds: String(parsed.use_of_funds || "").trim().slice(0, PITCH_TEXT_MAX_LENGTH)
    };
}
