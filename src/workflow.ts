import { tool, fileSearchTool, Agent, AgentInputItem, Runner, withTrace } from "@openai/agents";
import { z } from "zod";
import { OpenAI } from "openai";
import { runGuardrails } from "@openai/guardrails";

// Tool definitions
const inviteAgent = tool({
  name: "inviteAgent",
  description: "Send a client dialogue to consultants when unable to answer a question or solve a problem.",
  parameters: z.object({
    client_id: z.string(),
    chat_id: z.string(),
  }),
  execute: async (input: { client_id: string; chat_id: string }) => {
    // Stub: replace with your CRM/helpdesk integration
    return {
      status: "queued",
      client_id: input.client_id,
      chat_id: input.chat_id,
    };
  },
});

const getContractInfo = tool({
  name: "getcontractinfo",
  description: "Returns contract/dogovor information in JSON format.",
  parameters: z.object({
    contractNumber: z.number().int(),
  }),
  execute: async (input: { contractNumber: number }) => {
    // Optional: load from env JSON map
    const raw = process.env.CONTRACT_INFO_JSON ?? "";
    if (!raw) return { found: false };
    try {
      const map = JSON.parse(raw) as Record<string, any>;
      const key = String(input.contractNumber);
      if (!map[key]) return { found: false };
      return { found: true, ...map[key] };
    } catch {
      return { found: false };
    }
  },
});

const fileSearch = fileSearchTool(["vs_6979f5f585988191b601024a541495d9"]);
const fileSearch1 = fileSearchTool(["vs_bxl0apPz9cTrHGB3CkQiXXT2"]);

// Shared client for guardrails and file search
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Guardrails definitions
const jailbreakGuardrailConfig = {
  guardrails: [{ name: "Jailbreak", config: { model: "gpt-5-nano", confidence_threshold: 0.7 } }],
};
const context = { guardrailLlm: client };

function guardrailsHasTripwire(results: any[]): boolean {
  return (results ?? []).some((r) => r?.tripwireTriggered === true);
}

function getGuardrailSafeText(results: any[], fallbackText: string): string {
  for (const r of results ?? []) {
    if (r?.info && "checked_text" in r.info) {
      return r.info.checked_text ?? fallbackText;
    }
  }
  const pii = (results ?? []).find((r) => r?.info && "anonymized_text" in r.info);
  return pii?.info?.anonymized_text ?? fallbackText;
}

async function scrubConversationHistory(history: any[], piiOnly: any): Promise<void> {
  for (const msg of history ?? []) {
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const part of content) {
      if (part && typeof part === "object" && part.type === "input_text" && typeof part.text === "string") {
        const res = await runGuardrails(part.text, piiOnly, context, true);
        part.text = getGuardrailSafeText(res, part.text);
      }
    }
  }
}

async function scrubWorkflowInput(workflow: any, inputKey: string, piiOnly: any): Promise<void> {
  if (!workflow || typeof workflow !== "object") return;
  const value = workflow?.[inputKey];
  if (typeof value !== "string") return;
  const res = await runGuardrails(value, piiOnly, context, true);
  workflow[inputKey] = getGuardrailSafeText(res, value);
}

async function runAndApplyGuardrails(inputText: string, config: any, history: any[], workflow: any) {
  const guardrails = Array.isArray(config?.guardrails) ? config.guardrails : [];
  const results = await runGuardrails(inputText, config, context, true);
  const shouldMaskPII = guardrails.find(
    (g) => g?.name === "Contains PII" && g?.config && g.config.block === false
  );
  if (shouldMaskPII) {
    const piiOnly = { guardrails: [shouldMaskPII] };
    await scrubConversationHistory(history, piiOnly);
    await scrubWorkflowInput(workflow, "input_as_text", piiOnly);
    await scrubWorkflowInput(workflow, "input_text", piiOnly);
  }
  const hasTripwire = guardrailsHasTripwire(results);
  const safeText = getGuardrailSafeText(results, inputText) ?? inputText;
  return {
    results,
    hasTripwire,
    safeText,
    failOutput: buildGuardrailFailOutput(results ?? []),
    passOutput: { safe_text: safeText },
  };
}

function buildGuardrailFailOutput(results: any[]) {
  const get = (name: string) =>
    (results ?? []).find((r: any) => (r?.info?.guardrail_name ?? r?.info?.guardrailName) === name);
  const pii = get("Contains PII"),
    mod = get("Moderation"),
    jb = get("Jailbreak"),
    hal = get("Hallucination Detection"),
    nsfw = get("NSFW Text"),
    url = get("URL Filter"),
    custom = get("Custom Prompt Check"),
    pid = get("Prompt Injection Detection"),
    piiCounts = Object.entries(pii?.info?.detected_entities ?? {})
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => k + ":" + (v as any[]).length),
    conf = jb?.info?.confidence;
  void conf;
  return {
    pii: { failed: piiCounts.length > 0 || pii?.tripwireTriggered === true, detected_counts: piiCounts },
    moderation: {
      failed: mod?.tripwireTriggered === true || (mod?.info?.flagged_categories ?? []).length > 0,
      flagged_categories: mod?.info?.flagged_categories,
    },
    jailbreak: { failed: jb?.tripwireTriggered === true },
    hallucination: {
      failed: hal?.tripwireTriggered === true,
      reasoning: hal?.info?.reasoning,
      hallucination_type: hal?.info?.hallucination_type,
      hallucinated_statements: hal?.info?.hallucinated_statements,
      verified_statements: hal?.info?.verified_statements,
    },
    nsfw: { failed: nsfw?.tripwireTriggered === true },
    url_filter: { failed: url?.tripwireTriggered === true },
    custom_prompt_check: { failed: custom?.tripwireTriggered === true },
    prompt_injection: { failed: pid?.tripwireTriggered === true },
  };
}

const pedrabotnikIntentClassifierSchema = z.object({
  category: z.enum([
    "about_institute",
    "program_choice",
    "documents_for_study",
    "registration",
    "application_submission",
    "payment",
    "learning_process",
    "attestation",
    "documents_submission",
    "other_question",
    "course_selection",
    "contract_support",
    "handoff",
  ]),
  confidence: z.number(),
  needs_clarification: z.boolean(),
  clarification_question: z.string(),
  needs_contract_number: z.boolean(),
});

const pedrabotnikIntentClassifier = new Agent({
  name: "№1 — Pedrabotnik_IntentClassifier",
  instructions: `Ты — строгий классификатор запросов для сайта педработник.рф (ИППК).
Твоя задача: по сообщению пользователя вернуть ТОЛЬКО JSON, строго по structured output.

Категории category (enum):
- about_institute
- program_choice
- documents_for_study
- registration
- application_submission
- payment
- learning_process
- attestation
- documents_submission
- other_question
- course_selection
- contract_support
- handoff

Правила категоризации:
1) contract_support:
- статус договора, оплата по договору, получены ли документы, трек-номер, статус выдачи/отправки удостоверения/диплома,
- “я отправил(а) диплом/документы, вы получили?”,
- “проверьте мой заказ/договор”
→ category="contract_support", needs_contract_number=true.

2) documents_submission:
- “куда прислать/прикрепить документы?”, “как отправить документы об образовании?”
→ category="documents_submission", needs_contract_number=false.

3) course_selection:
- подбор курса/программы, “что выбрать”, “какой курс мне нужен”, “переподготовка или повышение”, “подберите 1–3 варианта”
→ category="course_selection".

4) 10 категорий main_information:
- about_institute / program_choice / documents_for_study / registration / application_submission / payment / learning_process / attestation / documents_submission
Если запрос явно относится к одной из них — ставь её.

5) other_question:
- если тема не ясна или пользователь пишет “Другой вопрос”
→ category="other_question", needs_clarification=true.

6) handoff:
- если пользователь просит другого консультанта
→ category="handoff".

needs_clarification:
- true только если для course_selection не хватает хотя бы одного:
  a) тип курса (переподготовка или повышение),
  b) тип организации (ДОУ/школа/колледж/доп.образование/автошкола),
  c) направление/профессия.
Тогда задай ОДИН короткий вопрос в clarification_question.
Иначе needs_clarification=false, clarification_question="".

confidence:
- 0.9–1.0 если явно
- 0.6–0.85 если частично
- <0.6 если очень мутно

Верни только JSON. Никакого текста.`,
  model: "gpt-5.1-chat-latest",
  outputType: pedrabotnikIntentClassifierSchema,
  modelSettings: {
    store: true,
  },
});

const pedrabotnikClarifier = new Agent({
  name: "№2 — Pedrabotnik_Clarifier (уточняющий)",
  instructions: `Ты — Арина, русскоязычный консультант педработник.рф (ИППК).
Твоя задача: задать ОДИН короткий уточняющий вопрос, чтобы понять запрос.

Правила:
- Только русский язык
- Без форматирования, без списков, без заголовков
- Ровно один вопрос
- Не предлагай курсы и не отвечай по сути, пока не получишь уточнение
- Если речь о выборе курса — уточняй недостающий параметр:
  1) Переподготовка или повышение квалификации?
  2) Где вы работаете (ДОУ/школа/колледж/доп.образование/автошкола)?
  3) Какое направление/должность/предмет вам нужен?

Сформулируй один вопрос, который закрывает самый критичный пробел.`,
  model: "gpt-5.1-chat-latest",
  modelSettings: {
    store: true,
  },
});

const pedrabotnikInfofaqAgent = new Agent({
  name: "№3 — Pedrabotnik_InfoFAQ_Agent (главный “вербатим” агент)",
  instructions: `Play the role of Arina, a russian consultant on the website педработник.рф (ИППК).
You speak perfect Russian. You understand the difference between "Сертификат" and "Диплом".

You MUST answer using ONLY the attached knowledge files:
- Main_information.txt
- dialog_pedrabotnik.txt

Critical output rules:
1) Always respond in Russian.
2) NO text formatting (no bold, italics, headings).
3) All links must be strict URL format.
4) NEVER invent facts. Use only what is explicitly written in the files.
5) Priority order of sources:
   A) dialog_pedrabotnik.txt is the PRIMARY truth for ready-made answers.
   B) Main_information.txt is used ONLY if there is no suitable answer in dialog_pedrabotnik.txt.

How to answer (deterministic):
Step 1: Read the user question and search for a matching Q/A in dialog_pedrabotnik.txt.
- If you find the closest matching question or intent, return the corresponding answer using the same wording style.
- You may not rewrite the meaning. Keep wording максимально близким к файлу.

Step 2: If no answer exists in dialog_pedrabotnik.txt, then use Main_information.txt.
- The workflow will pass you an input "category" (one of: about_institute, program_choice, documents_for_study, registration, application_submission, payment, learning_process, attestation, documents_submission).
- Locate the exact section by title in Main_information.txt and return the full text following that title VERBATIM.
- Absolutely no modifications. No summarization. No paraphrasing.

Special forced rules:
A) If user asks about sending/attaching education documents (куда прислать/прикрепить документы):
ALWAYS output exactly this text:

"Добрый день! Для отправки документов вы можете воспользоваться следующими способами:

1. Загрузить документы в вашем личном кабинете на сайте Педработник.РФ, используя кнопку «Загрузка файлов».
2. Отправить документы на электронную почту: 89081725519@mail.ru или 89185742875@mail.ru .
Если у вас возникнут дополнительные вопросы, пожалуйста, дайте знать!"

B) If user says they already sent documents or asks whether documents were received:
Ask for the contract number in one short sentence and stop.

C) If user asks about learning materials access:
Explain that materials will be available after payment in the personal account and provide the navigation text:
"Once payment is completed, learning materials will be available in your personal account on педработник.рф. Log in, click on ‘Learning Materials and Tests,’ then click the active blue line under the arrow for ‘Learning Materials’ — this is your coursebook that you study independently and use for final testing on the assigned day."

Escalation:
ONLY if the answer cannot be found in BOTH files OR user asks for another consultant:
Output ONLY this message (verbatim) and then call InviteAgent. The user must not know about the function call:

"Благодарю за Ваше обращение! К сожалению, на данный вопрос я не могу предоставить полный ответ, так как он требует участия наших сотрудников. 
Вы можете:
- Позвонить нам в рабочее время с 9:00 до 18:00 (МСК) по бесплатному номеру +78002501015
- Связаться напрямую с вашим персональным менеджером:

Карина: +79515357410
Ирина: +79185742875

Наши специалисты будут рады помочь вам и ответить на все вопросы. Спасибо за понимание!"

Always finish normal answers with:
"Подскажите, это помогло?"`,
  model: "gpt-5.1-chat-latest",
  tools: [inviteAgent, fileSearch],
  modelSettings: {
    parallelToolCalls: true,
    store: true,
  },
});

const pedrabotnikCourseSelector = new Agent({
  name: "№4 — Pedrabotnik_CourseSelector",
  instructions: `Ты — Арина, консультант педработник.рф (ИППК).
Твоя зона ответственности — ПОДБОР ПРОГРАММ (курсов). Используй только прикрепленные файлы.

Источники:
- Переподготовка.json (Профессиональная переподготовка)
- Повышение квалификации.json (Повышение квалификации)
- dialog_pedrabotnik.txt (стиль ответов как у менеджеров)

Правила:
1) Русский язык. Без форматирования.
2) Никаких выдумок: названия, часы, цены, ссылки — только из JSON.
3) Ссылки — строго URL.
4) Если пользователь не указал:
   a) нужно ли “Профессиональная переподготовка” или “Повышение квалификации”
   b) где он работает (ДОУ/школа/колледж/доп.образование/автошкола)
   c) направление/должность/предмет
   — задай ОДИН уточняющий вопрос и остановись.

Алгоритм подбора:
- Выбери 1–3 наиболее подходящих курса по совпадению:
  - education_level ↔ тип учреждения пользователя
  - professions/ключевые слова ↔ должность/направление пользователя
  - course_name содержит ключевую профессию и для кого подходит (важно)
- Для "Труд" и "Технология" считай это одним направлением и приоритезируй программы, где в названии есть труд/технология.

Формат ответа (строго):
Для каждого курса:
1) Название: <course_name>
2) Тип: <course_type>
3) Стоимость и длительность: <pricing_and_course_length> (все варианты)
4) Ссылка: <course_page_link>

Если пользователь просит курс, которого нет в файлах:
Скажи ровно: "К сожалению, этой программы нет на сайте."
И не упоминай файлы.

Если вопрос вообще не про подбор курсов:
Передай в InviteAgent с фиксированным сообщением эскалации.

В конце: "Подскажите, это помогло?"`,
  model: "gpt-5.1-chat-latest",
  tools: [inviteAgent, fileSearch1],
  modelSettings: {
    parallelToolCalls: true,
    store: true,
  },
});

const pedrabotnikContractSupport = new Agent({
  name: "№5 — Pedrabotnik_ContractSupport",
  instructions: `Ты — Арина, консультант педработник.рф (ИППК). Ты обрабатываешь ТОЛЬКО вопросы по договору.

Правила:
1) Русский язык. Без форматирования.
2) Если пользователь не указал номер договора — попроси номер договора одним коротким предложением и остановись.
3) Если номер договора указан — вызови getContractInfo с этим номером.
4) Ответ формируй ТОЛЬКО на основе данных, которые вернула функция:
- статус оплаты
- статус получения документов компанией
- статус подготовки/отправки документа об образовании
- трек-номер посылки (если есть)
5) Если функция не дала нужного ответа или пользователь просит изменить данные, реквизиты, ФИО, телефон, адрес и т.п.:
выведи ТОЛЬКО сообщение эскалации и вызови InviteAgent.

В конце обычного ответа: "Подскажите, это помогло?"`,
  model: "gpt-5.1-chat-latest",
  tools: [getContractInfo, inviteAgent, fileSearch],
  modelSettings: {
    parallelToolCalls: true,
    store: true,
  },
});

type WorkflowInput = { input_as_text: string };

function withCategoryMessage(category: string): AgentInputItem {
  return {
    role: "assistant",
    content: [{ type: "output_text", text: category }],
  } as AgentInputItem;
}

// Main code entrypoint
export const runWorkflow = async (workflow: WorkflowInput) => {
  return await withTrace("Готовый Агент Педработник Новый", async () => {
    const conversationHistory: AgentInputItem[] = [
      { role: "user", content: [{ type: "input_text", text: workflow.input_as_text }] },
    ];
    const runner = new Runner({
      traceMetadata: {
        __trace_source__: "agent-builder",
        workflow_id: "wf_6979e38b933481908cbb1beac8e59d3f0a48f41fafd4d2c6",
      },
    });

    const guardrailsInputText = workflow.input_as_text;
    const {
      hasTripwire: guardrailsHasTripwireResult,
      safeText: guardrailsAnonymizedText,
      failOutput: guardrailsFailOutput,
      passOutput: guardrailsPassOutput,
    } = await runAndApplyGuardrails(guardrailsInputText, jailbreakGuardrailConfig, conversationHistory, workflow);

    const guardrailsOutput = guardrailsHasTripwireResult ? guardrailsFailOutput : guardrailsPassOutput;
    if (guardrailsHasTripwireResult) {
      return guardrailsOutput;
    }

    void guardrailsAnonymizedText;

    const intentResultTemp = await runner.run(pedrabotnikIntentClassifier, [...conversationHistory]);
    conversationHistory.push(...intentResultTemp.newItems.map((item) => item.rawItem));

    if (!intentResultTemp.finalOutput) {
      throw new Error("Agent result is undefined");
    }

    const intentResult = {
      output_text: JSON.stringify(intentResultTemp.finalOutput),
      output_parsed: intentResultTemp.finalOutput,
    };

    if (intentResult.output_parsed.confidence < 0.6 || intentResult.output_parsed.needs_clarification === true) {
      const clarifierTemp = await runner.run(pedrabotnikClarifier, [...conversationHistory]);
      conversationHistory.push(...clarifierTemp.newItems.map((item) => item.rawItem));
      if (!clarifierTemp.finalOutput) throw new Error("Agent result is undefined");
      return { output_text: clarifierTemp.finalOutput ?? "" };
    }

    if (intentResult.output_parsed.category === "contract_support") {
      const contractTemp = await runner.run(pedrabotnikContractSupport, [...conversationHistory]);
      conversationHistory.push(...contractTemp.newItems.map((item) => item.rawItem));
      if (!contractTemp.finalOutput) throw new Error("Agent result is undefined");
      return { output_text: contractTemp.finalOutput ?? "" };
    }

    if (intentResult.output_parsed.category === "course_selection") {
      const courseTemp = await runner.run(pedrabotnikCourseSelector, [...conversationHistory]);
      conversationHistory.push(...courseTemp.newItems.map((item) => item.rawItem));
      if (!courseTemp.finalOutput) throw new Error("Agent result is undefined");
      return { output_text: courseTemp.finalOutput ?? "" };
    }

    const infoTemp = await runner.run(pedrabotnikInfofaqAgent, [
      ...conversationHistory,
      withCategoryMessage(intentResult.output_parsed.category),
    ]);
    conversationHistory.push(...infoTemp.newItems.map((item) => item.rawItem));
    if (!infoTemp.finalOutput) throw new Error("Agent result is undefined");
    return { output_text: infoTemp.finalOutput ?? "" };
  });
};
