# Raisium: juridiske spørsmål før lansering

**Grunnlag for vurdering hos advokat**

---

Dette notatet beskriver hvordan Raisium er bygget, og hvilke spørsmål vi trenger
en juridisk vurdering av før tjenesten tar imot ekte penger. Det er skrevet slik
at det kan leses uten kjennskap til systemet. Hvordan beløpene skal klassifiseres
i regnskapet er behandlet separat i `RC_ACCOUNTING_SIGNOFF.md`.

---

## 1. Hva Raisium er

Raisium er programvare. En startup (et norsk AS) bruker den til å ta inn
kapital fra personer den allerede kjenner: venner og familie, engelinvestorer
og investorer i sitt eget nettverk.

Flyten:

1. Startupen registrerer seg med organisasjonsnummer. Rollen i selskapet
   kontrolleres mot Brønnøysundregistrene.
2. Startupen setter vilkårene for runden (målbeløp 10 000–100 000 NOK,
   valuation cap, eventuell rabatt, long-stop på 24 måneder) og laster opp
   vedtektene.
3. Startupen lager **én personlig lenke per navngitt person** og sender den
   selv, på SMS, e-post eller lignende. Lenken låses til den første kontoen som
   tar den i bruk.
4. Den inviterte oppretter tilgang, leser vilkårene, registrerer et beløp
   (minst 1 000 NOK) og signerer en RC-avtale direkte med selskapet.
5. Investoren betaler investeringsbeløpet **direkte til selskapets konto**,
   enten med Stripe Connect («direct charge» til selskapets egen Stripe-konto)
   eller med bankoverføring.
6. Ved en utløsende hendelse (ny priset runde, kontrollendring eller utløp
   etter 24 måneder) lager Raisium dokumentene til en kapitalforhøyelse etter
   aksjeloven kapittel 10. Investoren betaler da aksjenes pålydende.

Det Raisium ikke gjør:

- viser ikke runder eller selskaper offentlig, og har ingen katalog investorer
  kan bla i;
- finner, anbefaler eller formidler ikke investorer eller selskaper;
- mottar, oppbevarer eller videreformidler aldri investorenes penger;
- tar ikke gebyr av investeringsbeløpene (startupen betaler en fast pris for
  programvaren);
- gir ikke råd og vurderer ikke selskapene.

Instrumentet er beskrevet i detalj i `RC_ACCOUNTING_SIGNOFF.md` og i malen
`templates/rc-template.html`.

---

## 2. Spørsmålene

### A. Aksjeloven kapittel 11

Ved inngåelse betaler investoren investeringsbeløpet og får en
kontraktsrettslig rett til senere å tegne aksjer. Antall aksjer beregnes som
`investeringsbeløp / (aksjepris − pålydende)`, og ved tegning betaler
investoren aksjenes pålydende som kontantinnskudd. Det utstedes ingen aksjer og
treffes ikke noe generalforsamlingsvedtak ved inngåelsen.

1. Er RC-avtalen en tegningsrett etter § 11-12, et konvertibelt lån etter
   § 11-1, eller et rent kontraktsrettslig instrument utenfor kapittel 11?
2. Hvis den faller inn under kapittel 11: må generalforsamlingen treffe vedtak
   med innholdet i § 11-2 eller § 11-13, og må vedtaket registreres i
   Foretaksregisteret, **før** investoren betaler? I dag gjør ikke flyten det.
3. Hvis svaret på 2 er ja, hva er den enkleste gyldige rekkefølgen for en
   runde der investorene kommer inn én og én over flere uker?

### B. Folkefinansiering og verdipapirregelverket

4. Er Raisium, slik det er beskrevet over, en folkefinansieringstjeneste
   etter lov om folkefinansieringstjenester og forordning (EU) 2020/1503? Vi
   legger særlig vekt på at det ikke skjer noen matching: startupen inviterer
   selv navngitte personer den kjenner, og runder vises ikke offentlig.
5. Er RC-avtalen et omsettelig verdipapir eller et annet finansielt instrument
   etter verdipapirhandelloven? Utøver Raisium i så fall en investeringstjeneste,
   for eksempel mottak og formidling av ordre?
6. Er en slik runde et tilbud til allmennheten, eller en rettet invitasjon?
   Vi antar at prospektplikt ikke er aktuelt gitt rundestørrelsen. Bekreft.
7. Hvilke grenser bør vilkårene sette for hvordan startupen inviterer, for at
   modellen skal holde? I dag krever vilkårene én personlig lenke per navngitt
   person, bare personer selskapet har en relasjon til, og ingen offentlig
   markedsføring.

### C. Hvitvasking

8. Raisium håndterer ikke midler. Stripe gjennomfører kundekontroll av
   selskapets Stripe-konto. Er Raisium rapporteringspliktig etter
   hvitvaskingsloven?

### D. Forbrukerspørsmål

9. Investorene vil ofte være forbrukere. Gir angrerettloven investoren
   angrerett på RC-avtalen med selskapet, og har Raisium eller selskapet i så
   fall en informasjonsplikt i flyten?
10. Er ansvarsbegrensningen i brukervilkårene (punkt 9) gyldig overfor
    forbrukere?

### E. Personvern

11. Er rollefordelingen riktig? Raisium er behandlingsansvarlig for kontoer,
    sikkerhet og drift. Selskapet er behandlingsansvarlig for opplysninger om
    sine investorer og aksjeeiere, og Raisium er databehandler for disse.
    Databehandleravtalen er tatt inn som punkt 8 i brukervilkårene.
12. Holder grunnlaget for å lagre fødselsnummer (aksjeloven § 4-5 sammen med
    personopplysningsloven § 12), og er lagringstidene i personvernerklæringen
    forsvarlige?
13. Gjennomgå `frontend/personvern.html` og `frontend/vilkar.html`. Begge er
    utkast skrevet ut fra hvordan systemet faktisk virker, og er ikke vurdert
    av jurist.

### F. Kapitalforhøyelsen og bekreftelsen av innskudd

14. Generalforsamlingsprotokollen sier nå at aksjeinnskuddet betales direkte
    til selskapet og kan disponeres før registrering, jf. aksjeloven § 10-13
    annet ledd. Investorene tegner aksjene ved å signere protokollen, etter
    møteleder og protokollunderskriver. Er ordlyden i
    `templates/gfc-template.html` og rekkefølgen gyldig?
15. Innskuddet bekreftes av en revisor Raisium betaler, jf. § 10-9 annet ledd.
    Kortbetalinger går til selskapets egen Stripe-konto og utbetales til
    selskapets bankkonto noen dager senere. Kan revisor bekrefte innbetalingen
    ut fra Stripes betalingsoppføring på selskapets konto, eller må pengene ha
    kommet inn på bankkontoen?
16. Revisor bekrefter også investeringsbeløpene i år 0, før noen aksjer finnes
    (`templates/round-payment-confirmation-template.html`). Er teksten
    dekkende, og skaper den noe ansvar for revisor eller Raisium?
17. Passer det at Raisium skaffer og betaler bekreftelsen, med at Raisium bare
    skal være programvare? Og er revisor databehandler for Raisium, eller
    selvstendig behandlingsansvarlig for opplysningene revisor ser?

---

## 3. Det vi har gjort i påvente av svar

- Raisium-posisjonen («programvare, ikke plattform») står konsekvent på
  forsiden, i brukervilkårene og på juridisk-siden.
- Hver invitasjon må knyttes til en navngitt person, og startupen ser hver
  person i en pipeline. Det finnes ikke lenger noen vei til anonyme lenker.
- Både startups og investorer må godta brukervilkårene og bekrefte at de har
  lest personvernerklæringen. Versjonen og tidspunktet lagres.
- Interne driftsvarsler (Telegram) inneholder ikke lenger navn, e-post eller
  fritekst.

---

## 4. Vedlegg

- `templates/rc-template.html`: RC-avtalen
- `RC_ACCOUNTING_SIGNOFF.md`: instrumentet og talleksempel
- `frontend/vilkar.html`: brukervilkår (utkast)
- `frontend/personvern.html`: personvernerklæring (utkast)
- `frontend/juridisk.html`: rollefordeling slik den vises til brukerne
