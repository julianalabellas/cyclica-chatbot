require("dotenv").config();
const express = require("express");
const cors = require("cors");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());

// ============================================================
// INICIALIZAÇÃO
// ============================================================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================================
// CONTEXTO DA EMPRESA
// ============================================================
const COMPANY_CONTEXT = `Cyclica: Rhythm that makes you grow.

We are an HR System company that believes in flexibility, automation, and humanity in the workplace.

Our Core Values:
- Empowering the workforce to drive organizational growth: We believe that recognizing and embracing our body's needs is essential for moving forward and reaching greater goals together. By acknowledging the organic and cyclical nature of our bodies, we transform our perspective on workplace productivity.
- Boosting economy by embracing natural cycles: Good professional relationships are built on trust and respect. By allowing employees to manage their work and personal needs more flexibly, we help organizations achieve their business goals while also improving people's well-being.

Our Office Culture:
- Heating pads available for menstrual discomfort or any other discomfort
- Period products in all restrooms for safety and comfort
- Comfort snacks, hot tea available for relaxation and refocus
- Well-being room with low stimulation for focused work when energy is low
- Flexible work arrangements based on how you feel: office, well-being room, home, or day off`;

// ============================================================
// QUESTIONÁRIO INICIAL
// ============================================================
const QUESTIONS = [
  {
    id: 1,
    question: "How do you adapt your tasks or expectations if your energy levels affect how you work?",
    evaluation_guide: {
      0: "Denies or ignores bodily impact on work",
      1: "Acknowledges impact but shows limited or reactive adaptation",
      2: "Clearly recognizes bodily signals and adapts work in a thoughtful, responsible way"
    }
  },
  {
    id: 2,
    question: "What kind of work environment helps you grow sustainably over time?",
    evaluation_guide: {
      0: "Growth linked mainly to pressure or constant performance",
      1: "Mentions balance without deeper reflection",
      2: "Emphasizes sustainability, rhythm, learning, and collective well-being"
    }
  },
  {
    id: 3,
    question: "What does productivity mean to you beyond delivering tasks on time?",
    evaluation_guide: {
      0: "Productivity defined only by output, speed, or hours worked",
      1: "Mentions quality or efficiency but remains task-focused",
      2: "Includes well-being, sustainability, long-term impact, or collective results"
    }
  },
  {
    id: 4,
    question: "In your opinion, what makes a workplace feel safe for people to express their needs?",
    evaluation_guide: {
      0: "Places responsibility only on individuals",
      1: "Mentions leadership or policies without cultural depth",
      2: "Recognizes trust, openness, listening, and shared cultural practices"
    }
  },
  {
    id: 5,
    question: "How do you feel working in an environment where flexibility and autonomy are encouraged?",
    evaluation_guide: {
      0: "Strong resistance to flexibility or need for constant supervision",
      1: "Accepts flexibility with reservations or difficulty",
      2: "Demonstrates comfort, responsibility, and clear communication habits"
    }
  }
];

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

// Gera ID único de sessão
function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Busca lista de PDFs disponíveis no banco
async function getAvailablePDFs() {
  try {
    const { data, error } = await supabase
      .from("embeddings")
      .select("filename")
      .limit(100);
    
    if (error) return [];
    
    const uniqueFiles = [...new Set(data.map(row => row.filename))];
    return uniqueFiles;
  } catch (error) {
    console.error("Error fetching PDFs:", error);
    return [];
  }
}

// Avalia resposta usando GPT e retorna score 0-2
async function evaluateAnswer(questionId, userAnswer) {
  const question = QUESTIONS.find(q => q.id === questionId);
  
  const prompt = `You are evaluating a candidate's cultural fit for Cyclica, a company that values body awareness, cyclical work rhythms, flexibility, and sustainable productivity.

Company Context:
${COMPANY_CONTEXT}

Question Asked: ${question.question}

Candidate's Answer: "${userAnswer}"

CRITICAL: Before evaluating, check for invalid responses:
- Repeated letters (e.g., "xxxx", "aaaa", "test test test")
- Non-meaningful text or gibberish
- Copy-pasted text unrelated to the question
→ If detected, assign score 0 immediately with reasoning: "Response appears to be placeholder text or invalid input"

Evaluation Guidelines (use these to assess the answer, NOT as expected answers):
- Score 0 if: ${question.evaluation_guide[0]}
- Score 1 if: ${question.evaluation_guide[1]}
- Score 2 if: ${question.evaluation_guide[2]}

Analyze the candidate's answer and determine how well it aligns with Cyclica's values. Consider:
- Awareness of bodily needs and their impact on work
- Openness to flexibility and non-traditional work structures
- Understanding of sustainable productivity vs. constant performance
- Respect for collective well-being and trust-based relationships

Respond ONLY with a JSON object:
{
  "score": <number 0-2>,
  "reasoning": "<brief explanation of why this score was given in relation to Cyclica's values>"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const content = response.choices[0].message.content.trim();
    const cleanContent = content.replace(/```json\n?|\n?```/g, "");
    const result = JSON.parse(cleanContent);
    
    return {
      score: result.score,
      reasoning: result.reasoning
    };
  } catch (error) {
    console.error("Error evaluating answer:", error);
    return { score: 1, reasoning: "Could not evaluate, assigned neutral score" };
  }
}

// Busca contexto relevante no Supabase via embeddings
async function findRelevantContext(userMessage, topK = 3) {
  try {
    // Gera embedding da mensagem do usuário
    const embResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: userMessage,
    });
    const queryEmbedding = embResponse.data[0].embedding;

    // Busca chunks similares no Supabase
    const { data, error } = await supabase.rpc("match_embeddings", {
      query_embedding: queryEmbedding,
      match_threshold: 0.7,
      match_count: topK,
    });

    if (error) {
      console.error("Error finding context:", error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error("Error in findRelevantContext:", error);
    return [];
  }
}

// Busca score e respostas do questionário
async function getAssessmentContext(sessionId) {
  try {
    const { data, error } = await supabase
      .from("chat_interactions")
      .select("user_message, metadata")
      .eq("session_id", sessionId)
      .eq("metadata->>phase", "questionnaire")
      .order("created_at", { ascending: true });

    if (error || !data || data.length === 0) return null;

    // Busca o score final
    const { data: completeData } = await supabase
      .from("chat_interactions")
      .select("metadata")
      .eq("session_id", sessionId)
      .eq("user_message", "QUESTIONNAIRE_COMPLETE")
      .single();

    const totalScore = completeData?.metadata?.total_score || 0;
    const feedbackRange = completeData?.metadata?.feedback_range || "unknown";

    // Monta resumo das respostas
    const answers = data
      .filter(d => d.user_message && !d.user_message.includes("SESSION"))
      .map((d, i) => `Q${i + 1}: ${d.user_message}`)
      .join("\n");

    return {
      total_score: totalScore,
      feedback_range: feedbackRange,
      answers: answers
    };
  } catch (error) {
    console.error("Error fetching assessment context:", error);
    return null;
  }
}

// Gera feedback baseado na pontuação total
function generateFeedback(totalScore) {
  if (totalScore <= 3) {
    return {
      range: "0-3",
      message: "Based on your responses, your current expectations around productivity, communication, and work structure appear to differ from Cyclica's approach to flexibility, body awareness, and cyclical work rhythms. This result does not reflect your professional value or capabilities, but rather a difference in how work, well-being, and autonomy are integrated into daily practices within our culture. This company is the outcome of a speculative design process that explores how workplaces could be reimagined to better accommodate different bodily needs. "
    };
  } else if (totalScore <= 6) {
    return {
      range: "4-6",
      message: "Your answers indicate a partial alignment with Cyclica’s values, with the potential to evolve through shared understanding and the right working context. This company is the outcome of a speculative design process that explores how workplaces could be reimagined to better accommodate different bodily needs."
    };
  } else if (totalScore <= 8) {
    return {
      range: "7-8",
      message: "Your responses demonstrate a solid awareness of personal rhythms, respect for colleagues' needs, and openness to flexible and asynchronous ways of working. This indicates a good alignment with Cyclica's culture and our belief that sustainable growth emerges from trust, autonomy, and well-being. This company is the outcome of a speculative design process that explores how workplaces could be reimagined to better accommodate different bodily needs."
    };
  } else {
    return {
      range: "9-10",
      message: "Your answers strongly resonate with Cyclica's vision of work as a cyclical, human-centered system. You demonstrate a deep understanding of body awareness, empathy, flexibility, and long-term sustainability — values that are central to how we build teams, relationships, and growth together. This company is the outcome of a speculative design process that explores how workplaces could be reimagined to better accommodate different bodily needs."
    };
  }
}

// ============================================================
// ROTAS DA API
// ============================================================

// Health check
app.get("/", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "Cyclica Cultural Fit Assessment API",
    endpoints: ["/start-session", "/chat", "/get-questions"]
  });
});

// Retorna as perguntas do questionário
app.get("/get-questions", (req, res) => {
  const questionsOnly = QUESTIONS.map(q => ({
    id: q.id,
    question: q.question
  }));
  res.json({ questions: questionsOnly });
});

// Inicia nova sessão
app.post("/start-session", async (req, res) => {
  try {
    const sessionId = generateSessionId();
    
    // Cria registro da sessão no Supabase
    const { error } = await supabase.from("chat_interactions").insert({
      session_id: sessionId,
      user_message: "SESSION_START",
      bot_response: "Cultural fit assessment initiated",
      interaction_type: "questionnaire",      
      question_number: null,
      metadata: { phase: "questionnaire", question_index: 0, scores: [] }
    });

    if (error) {
      console.error("Error creating session:", error);
      return res.status(500).json({ error: "Failed to create session" });
    }

    res.json({
      session_id: sessionId,
      message: "Welcome to Cyclica's cultural fit assessment",
      first_question: QUESTIONS[0].question,
      question_id: 1,
      total_questions: QUESTIONS.length
    });
  } catch (error) {
    console.error("Error in /start-session:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================
// VALIDATION HELPER
// ============================================================
function isValidAnswer(answer) {
  // Check for repeated characters (3+ in a row)
  if (/(.)\1{2,}/.test(answer)) return false;
  
  // Check minimum length
  if (answer.length < 10) return false;
  
  // Check for too many repeated words
  const words = answer.toLowerCase().split(/\s+/);
  const uniqueWords = new Set(words);
  if (words.length > 5 && uniqueWords.size < words.length * 0.3) return false;
  
  return true;
}

// Rota principal de chat
app.post("/chat", async (req, res) => {
  try {
    const { session_id, message, question_id, phase } = req.body;

    if (!session_id || !message) {
      return res.status(400).json({ error: "session_id and message are required" });
    }
    
    // ============================================================
    // FASE 1: QUESTIONÁRIO
    // ============================================================
    if (phase === "questionnaire" && question_id) {
      // Avalia a resposta
      const evaluation = await evaluateAnswer(question_id, message);
      
      // Busca histórico da sessão
      const { data: sessionData } = await supabase
        .from("chat_interactions")
        .select("metadata")
        .eq("session_id", session_id)
        .order("created_at", { ascending: false })
        .limit(1);

      const currentScores = sessionData?.[0]?.metadata?.scores || [];
      const newScores = [...currentScores, { question_id, score: evaluation.score }];
      const totalScore = newScores.reduce((sum, s) => sum + s.score, 0);

      // Salva interação
      await supabase.from("chat_interactions").insert({
        session_id,
        user_message: message,
        bot_response: evaluation.reasoning,
        interaction_type: "questionnaire",    
        question_number: question_id, 
        score: evaluation.score,
        metadata: {
          phase: "questionnaire",
          question_id,
          score: evaluation.score,
          scores: newScores,
          total_score: totalScore
        }
      });

      // Se ainda há perguntas, retorna a próxima
      if (question_id < QUESTIONS.length) {
        const nextQuestion = QUESTIONS[question_id];
        return res.json({
          type: "next_question",
          question: nextQuestion.question,
          question_id: nextQuestion.id,
          current_score: totalScore,
          progress: `${question_id}/${QUESTIONS.length}`
        });
      }

      // Questionário completo - gera feedback
      const feedback = generateFeedback(totalScore);
      
      await supabase.from("chat_interactions").insert({
        session_id,
        user_message: "QUESTIONNAIRE_COMPLETE",
        bot_response: feedback.message,
        interaction_type: "questionnaire",      
        question_number: null, 
        score: totalScore, 
        metadata: {
          phase: "questionnaire_complete",
          total_score: totalScore,
          feedback_range: feedback.range,
          scores: newScores
        }
      });

      return res.json({
        type: "questionnaire_complete",
        total_score: totalScore,
        feedback: feedback.message,
        feedback_range: feedback.range,
        message: "Do you want to talk more about any of these topics? Feel free to drop your doubts so we can explain better to you our vision."
      });
    }

    // ============================================================
    // FASE 2: CHAT LIVRE COM CONTEXTO COMPLETO
    // ============================================================
    if (phase === "free_chat") {
      // Busca contexto do assessment (se foi feito)
      const assessmentContext = await getAssessmentContext(session_id);
      
      // Busca contexto relevante dos PDFs
      const relevantChunks = await findRelevantContext(message, 3);
      
      // Busca lista de PDFs disponíveis
      const availablePDFs = await getAvailablePDFs();
      
      // Monta contexto para o GPT
      let contextText = `\n\nAvailable Research Documents in Database:\n`;
      if (availablePDFs.length > 0) {
        contextText += availablePDFs.map((pdf, i) => `${i + 1}. ${pdf}`).join("\n");
      } else {
        contextText += "No documents currently available.";
      }

      if (relevantChunks.length > 0) {
        contextText += "\n\nRelevant excerpts from research:\n\n";
        relevantChunks.forEach((chunk, i) => {
          contextText += `[Excerpt ${i + 1} from ${chunk.filename}]\n${chunk.content}\n\n`;
        });
      }

      // Adiciona contexto do assessment
      let assessmentInfo = "";
      if (assessmentContext) {
        assessmentInfo = `\n\nCandidate's Assessment Context:
- Total Score: ${assessmentContext.total_score}/10 (Range: ${assessmentContext.feedback_range})
- This indicates their level of alignment with Cyclica's values

Previous answers from assessment:
${assessmentContext.answers}

Use this context to provide more personalized responses based on their alignment level.`;
      }

      // Busca histórico recente da conversa
      const { data: history } = await supabase
        .from("chat_interactions")
        .select("user_message, bot_response")
        .eq("session_id", session_id)
        .eq("metadata->>phase", "free_chat")
        .order("created_at", { ascending: true })
        .limit(10);

      const conversationHistory = history
        ?.map(h => [
          { role: "user", content: h.user_message },
          { role: "assistant", content: h.bot_response }
        ])
        .flat() || [];

      // Mensagens para o GPT
      const messages = [
        {
          role: "system",
          content: `You are an empathetic HR professional representing Cyclica, a fictional company created as part of a Master’s thesis in Design and Interaction.
All conversations are academic and exploratory in nature and are part of a speculative research project.
The recruitment process presented here is fictional and exists only to support reflection and research.

This chat takes place after an initial conversation where we explored your perspectives on work, well-being, and values.
Never refer to it as an "assessment" or "test" — it was simply a reflective dialogue.
Its purpose is not evaluation, but to offer space for deeper reflection and dialogue around Cyclica’s values, ideas, and vision of work.

At Cyclica, we believe that work is shaped by people, rhythms, and relationships. We focus on flexibility, well-being, collaboration, and sustainable growth rather than solely on skills or performance.
Important:
- Never use words like "assessment", "test", "evaluation", or "score" when referring to previous responses
- Instead say: "your previous responses", "what you shared earlier", "our earlier conversation"

Tone of voice: empathetic, warm, respectful, collaborative
Response style: short, clear texts (2–4 sentences), human and conversational
Approach: reflective, non-judgmental, supportive, peer-to-peer (not superior)
Depth: grounded in Designing Futures principles (speculation, critique, rethinking dominant productivity narratives), translated into accessible language
Knowledge base: use the database as a primary reference to connect well-being, bodily rhythms, and cultural perceptions of menstruation, without academic or medical claims

CRITICAL LANGUAGE GUIDELINES:
- AVOID phrases like "We at Cyclica", "At Cyclica we", "Cyclica believes" 
- INSTEAD use: "This approach focuses on...", "The idea is that...", "One way to think about it..."
- Speak as equals having a conversation, not as company representatives lecturing
- Frame ideas as invitations to explore, not assertions of superiority
- Use "you might find", "some people experience", "research suggests" instead of "we provide", "we offer"
- When discussing company practices, say "This includes..." not "We have..."

Examples:
❌ "We at Cyclica believe that flexibility is key"
✅ "Flexibility can be key to sustainable work"

❌ "At Cyclica, we provide heating pads"
✅ "Things like heating pads or quiet spaces can make a real difference"

❌ "We value cyclical rhythms"
✅ "Recognizing the body's natural rhythms can reshape how we think about productivity"

Encourage reflection, normalize different experiences, and invite dialogue as peers.
Do not position Cyclica as having all the answers or being superior to other workplaces.
Do not assess, diagnose, persuade, or promise outcomes.
Do not use yes/no questions or technical jargon.

Always prioritize psychological safety and agency.
End reflective explanations by inviting the user to continue the conversation or ask questions about Cyclica’s vision..

${COMPANY_CONTEXT}

${contextText}

${assessmentInfo}

Your role is to:
- Answer questions about Cyclica's approach to workplace well-being, flexibility, and cyclical work rhythms
- Reference the research documents when relevant to support your explanations
- Explain how our values translate into daily practices
- Be warm, welcoming, and honest about our culture
- Help candidates understand if they would thrive in our environment
- Tailor responses based on their assessment score if available
- Create space for their perspective, not just present Cyclica's view`
        },
        ...conversationHistory.slice(-6),
        { role: "user", content: message }
      ];

      // Chama GPT
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages,
        temperature: 0.7,
        max_tokens: 500
      });

      const botResponse = completion.choices[0].message.content;

      // Salva interação
      await supabase.from("chat_interactions").insert({
        session_id,
        user_message: message,
        bot_response: botResponse,
        interaction_type: "free_chat",       
        question_number: null, 
        score: null,  
        metadata: {
          phase: "free_chat",
          context_used: relevantChunks.length > 0,
          assessment_score: assessmentContext?.total_score || null
        }
      });

      return res.json({
        type: "chat_response",
        message: botResponse
      });
    }

    // Fase não reconhecida
    return res.status(400).json({ error: "Invalid phase. Use 'questionnaire' or 'free_chat'" });

  } catch (error) {
    console.error("Error in /chat:", error);
    res.status(500).json({ 
      error: "Internal server error",
      details: error.message 
    });
  }
});

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Cyclica API running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/`);
  console.log(`📋 Questions: http://localhost:${PORT}/get-questions`);
});

module.exports = app;
