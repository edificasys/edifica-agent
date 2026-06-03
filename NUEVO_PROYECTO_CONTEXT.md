# Contexto para Nuevo Proyecto: NotebookLM Propio

> Este documento se usa como contexto inicial al abrir Claude Code en el nuevo proyecto.
> Copiar como `CLAUDE.md` en la raíz del nuevo proyecto.

---

## 1. Proyecto de Referencia: AIWorker (YA FUNCIONA EN PRODUCCIÓN)

AIWorker es un asistente WhatsApp multiagente que sirve como arquitectura base probada.
Está desplegado en **Render** (backend), usa **Neon** (PostgreSQL) y su dashboard en **Vercel**.

### Stack probado y funcionando

```
Backend Node.js (Express)  →  Render (free tier)
Dashboard Next.js/React    →  Vercel (free tier)
Base de datos              →  Neon PostgreSQL (free tier)
IA de texto                →  Groq API (Llama 3.3 70B) — gratis
IA de imágenes/docs        →  Google Gemini 1.5 Flash — gratis
WhatsApp                   →  Baileys (sin API oficial) — gratis
```

### Estructura de AIWorker (referencia)

```
AIWorker/
├── src/
│   ├── index.js     # Servidor principal (WhatsApp + HTTP API + Cron)
│   ├── ai.js        # Motor IA: 5 agentes, prompts dinámicos
│   ├── db.js        # Capa PostgreSQL: 26+ métodos
│   └── alerts.js    # Notificaciones WhatsApp al admin
├── schema.sql       # Esquema de base de datos
└── .env.example     # Variables de entorno
```

### Patrones clave que reutilizar

- **Multi-agente por prompts**: mismo LLM, diferentes `systemPrompt` según contexto detectado
- **Historial en BD**: últimos N mensajes como contexto para coherencia
- **SSE para tiempo real**: notificaciones push sin WebSockets
- **Auth por session token**: header `X-Session-Token`, 7 días de validez
- **Migraciones automáticas al startup**: `ALTER TABLE IF NOT EXISTS` — sin herramienta externa
- **Configuración en BD** (`ai_settings`): prompts, FAQs, whitelist — editable desde dashboard sin redeploy

---

## 2. Nuevo Proyecto: DocChat (NotebookLM Propio)

### Qué es

Plataforma web donde el usuario sube documentos (PDF, TXT, DOCX, URLs) y puede **chatear con ellos** usando IA. Similar a NotebookLM de Google pero propio, privado y gratuito.

### Stack del nuevo proyecto (mismo patrón que AIWorker)

```
Backend Node.js (Express)  →  Render
Frontend Next.js           →  Vercel
Base de datos              →  Neon PostgreSQL + pgvector
IA de texto                →  Groq API (Llama 3.3 70B) — gratis
Embeddings                 →  Groq o Gemini text-embedding — gratis
Extracción de texto        →  pdf-parse, mammoth (DOCX), cheerio (URLs)
```

### Por qué pgvector en Neon

Neon soporta la extensión `pgvector` nativamente. Esto permite guardar embeddings
vectoriales en la misma BD PostgreSQL sin servicio externo (sin Pinecone, sin Weaviate).

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id),
  content TEXT,
  embedding vector(768),  -- dimensión según modelo de embedding
  chunk_index INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops);
```

---

## 3. Arquitectura del Nuevo Proyecto

### Estructura de carpetas propuesta

```
docchat/
├── src/
│   ├── index.js         # Servidor Express + endpoints REST
│   ├── ai.js            # RAG: embeddings, búsqueda semántica, respuesta
│   ├── db.js            # PostgreSQL + pgvector
│   ├── ingest.js        # Parseo de documentos: PDF, DOCX, URL, TXT
│   └── auth.js          # Auth de usuarios (mismo patrón AIWorker)
├── schema.sql           # Esquema con pgvector
├── .env.example
└── package.json
```

### Flujo completo de usuario

```
1. INGEST (subir documento)
   Usuario sube PDF/DOCX/URL
         │
         ▼
   ingest.js extrae texto plano
         │
         ▼
   Dividir en chunks (500 tokens, 50 overlap)
         │
         ▼
   Gemini/Groq genera embedding por chunk (vector 768d)
         │
         ▼
   Guardar en PostgreSQL (document_chunks + embedding)

2. CHAT (preguntar sobre el documento)
   Usuario escribe pregunta
         │
         ▼
   ai.js genera embedding de la pregunta
         │
         ▼
   pgvector busca top-5 chunks más similares (cosine similarity)
         │
         ▼
   Construir prompt: system + chunks relevantes + historial + pregunta
         │
         ▼
   Groq Llama 3.3 70B genera respuesta
         │
         ▼
   Respuesta + referencias de página al usuario (SSE streaming)
```

### Tablas de base de datos

```sql
-- Usuarios (mismo patrón AIWorker)
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sesiones (mismo patrón AIWorker)
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Notebooks (colección de documentos)
CREATE TABLE notebooks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Documentos
CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  notebook_id INTEGER REFERENCES notebooks(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'pdf', 'docx', 'url', 'txt'
  source TEXT,         -- URL original o nombre de archivo
  raw_text TEXT,       -- texto completo extraído
  chunk_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chunks con embeddings vectoriales
CREATE TABLE document_chunks (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(768),
  chunk_index INTEGER,
  page_number INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Conversaciones por notebook
CREATE TABLE conversations (
  id SERIAL PRIMARY KEY,
  notebook_id INTEGER REFERENCES notebooks(id),
  user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Mensajes del chat
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  role TEXT NOT NULL,  -- 'user' | 'assistant'
  content TEXT NOT NULL,
  sources JSONB,       -- chunks usados como contexto
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 4. Endpoints API (backend en Render)

### Auth (igual que AIWorker)
```
POST /api/auth/login          — Login, retorna session token
GET  /api/users/me            — Validar token actual
```

### Notebooks
```
GET    /api/notebooks         — Listar notebooks del usuario
POST   /api/notebooks         — Crear notebook
DELETE /api/notebooks/:id     — Eliminar notebook + documentos
```

### Documentos (ingest)
```
POST   /api/notebooks/:id/documents        — Subir PDF/DOCX/TXT (multipart)
POST   /api/notebooks/:id/documents/url    — Ingestar desde URL
GET    /api/notebooks/:id/documents        — Listar documentos
DELETE /api/documents/:id                  — Eliminar documento + chunks
```

### Chat
```
GET  /api/notebooks/:id/conversations      — Historial de conversaciones
POST /api/notebooks/:id/chat               — Enviar mensaje (respuesta SSE streaming)
GET  /api/conversations/:id/messages       — Mensajes de una conversación
```

### Status
```
GET /health                                — Estado del servidor
```

---

## 5. Variables de entorno (.env)

```env
# Base de datos (Neon)
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/docchat?sslmode=require

# IA
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=AIza...

# Auth
SESSION_SECRET=una_clave_random_larga
ADMIN_PASSWORD=password_del_admin_inicial

# Servidor
PORT=3000
NODE_ENV=production
```

---

## 6. Dependencias del nuevo proyecto (package.json base)

```json
{
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.0",
    "groq-sdk": "^0.9.0",
    "@google/generative-ai": "^0.21.0",
    "pdf-parse": "^1.1.1",
    "mammoth": "^1.6.0",
    "cheerio": "^1.0.0-rc.12",
    "multer": "^1.4.5",
    "dotenv": "^16.4.7",
    "bcrypt": "^5.1.1",
    "uuid": "^9.0.0"
  }
}
```

---

## 7. Diferencias clave respecto a AIWorker

| Aspecto | AIWorker | DocChat (nuevo) |
|---|---|---|
| Canal de entrada | WhatsApp (Baileys) | Web (dashboard) |
| Conocimiento del agente | Prompts + FAQ en BD | RAG: documentos subidos |
| Búsqueda | Palabras clave | Semántica (embeddings + pgvector) |
| Multi-agente | 5 agentes por prompt | 1 agente RAG configurable |
| Media | Imágenes, audios | PDFs, DOCX, URLs, TXT |
| Cron | Recontacto, reportes | Opcional (limpieza de sessions) |

---

## 8. Fases de desarrollo sugeridas

### Fase 1 — Backend core
- [ ] `schema.sql` con pgvector
- [ ] `db.js` con métodos básicos (usuarios, notebooks, documentos, chunks)
- [ ] `ingest.js` para PDF + TXT
- [ ] `ai.js` con RAG básico (embed → buscar → responder)
- [ ] `index.js` con endpoints auth + notebooks + chat

### Fase 2 — Más formatos y calidad
- [ ] Soporte DOCX (mammoth)
- [ ] Soporte URL (cheerio scraping)
- [ ] SSE streaming de respuestas
- [ ] Referencias de página en respuesta

### Fase 3 — Dashboard (Vercel)
- [ ] Login + sesión
- [ ] Listado de notebooks
- [ ] Upload de documentos con progreso
- [ ] Interfaz de chat con el documento
- [ ] Historial de conversaciones

### Fase 4 — Pulido
- [ ] Multi-usuario completo
- [ ] Soporte multi-documento en mismo notebook (preguntar entre varios)
- [ ] Export de conversación
- [ ] Límites de uso por usuario

---

## 9. Consideraciones de despliegue

### Render (backend)
- Free tier: 512MB RAM, se duerme tras 15min inactividad
- El procesamiento de PDFs grandes puede ser lento en free tier
- Para archivos subidos: usar Render disk o guardar en Neon como bytea/base64

### Neon (base de datos)
- Habilitar extensión pgvector: `CREATE EXTENSION IF NOT EXISTS vector;`
- Free tier: 512MB storage, suficiente para empezar
- pgvector soportado nativamente en Neon

### Vercel (dashboard)
- Next.js con App Router
- Variables de entorno: `NEXT_PUBLIC_API_URL=https://tu-app.onrender.com`

---

## 10. Notas importantes

- **Embeddings gratuitos**: Groq no tiene API de embeddings aún. Usar Gemini
  `text-embedding-004` (768 dimensiones, gratis) o nomic-embed via Ollama local.
- **Tamaño de chunks**: 500 tokens con 50 de overlap es un buen punto de partida.
  Ajustar según calidad de respuestas.
- **Contexto al LLM**: pasar máximo 5-8 chunks por query para no superar el límite
  de tokens y mantener la respuesta enfocada.
- **Sin Ollama en producción**: en Render (free tier) no hay GPU ni suficiente RAM
  para modelos locales. Ollama solo para desarrollo local si se quiere.
