import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import { createRequire } from 'module';
import mammoth from 'mammoth';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

const require = createRequire(import.meta.url);
let pdf: any;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define storage paths
const DATA_DIR = path.join(process.cwd(), 'data');
const DOCUMENTS_FILE = path.join(DATA_DIR, 'documents.json');

// Global document list to avoid frequent file reads and race conditions during runtime
let cachedDocuments: any[] = [];

// Initialize data directory and file
async function initializeStorage() {
  console.log('[Storage] Initializing storage...');
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
      const data = await fs.readFile(DOCUMENTS_FILE, 'utf-8');
      cachedDocuments = JSON.parse(data);
      console.log(`[Storage] Loaded ${cachedDocuments.length} documents.`);
    } catch {
      await fs.writeFile(DOCUMENTS_FILE, JSON.stringify([]));
      cachedDocuments = [];
      console.log('[Storage] Created new empty store.');
    }
  } catch (err) {
    console.error('[Storage] Init failure:', err);
  }
}

// Memory-to-disk sync helper
async function syncToDisk() {
  try {
    await fs.writeFile(DOCUMENTS_FILE, JSON.stringify(cachedDocuments, null, 2));
    console.log('[Storage] Synced to disk.');
  } catch (err) {
    console.error('[Storage] Sync failure:', err);
  }
}

// Extend Request type for Multer
interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const app = express();
const PORT = 3000;

// Logging middleware - CRITICAL for debugging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB
  }
});

// API Routes
const apiRouter = express.Router();

// Chat endpoint
apiRouter.post('/chat', async (req: Request, res: Response) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || req.body.apiKey;
    if (!apiKey) {
      return res.status(400).json({ error: 'Không tìm thấy GEMINI_API_KEY trên máy chủ' });
    }

    const { messages, systemInstruction } = req.body;
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' }
      }
    });

    const contents = (messages || []).map((m: any) => ({
      role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));

    const result = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction: systemInstruction || ''
      }
    });

    res.json({ text: result.text });
  } catch (err: any) {
    console.error('[API Chat Error]:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Lỗi khi gọi mô hình AI' });
  }
});

// Get all documents
apiRouter.get('/documents', (req, res) => {
  console.log(`[API] Returning ${cachedDocuments.length} docs`);
  res.json(cachedDocuments);
});

// Process and save files
apiRouter.post('/process-file', upload.single('file'), async (req: Request, res: Response) => {
  console.log('[API] Processing file upload...');
  const multerReq = req as MulterRequest;
  
  try {
    if (!multerReq.file) {
      console.warn('[API] No file in request');
      return res.status(400).json({ error: 'Không có file nào được tải lên' });
    }

    const { originalname, buffer, mimetype } = multerReq.file;
    console.log(`[API] Processing Upload: ${originalname} | Mime: ${mimetype} | Size: ${buffer.length} bytes`);
    
    let content = '';
    let type: 'text' | 'image' = 'text';
    let data_base64 = '';

    try {
      const isWord = 
        mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimetype === 'application/msword' ||
        mimetype === 'application/vnd.ms-word.document.macroEnabled.12' ||
        mimetype === 'application/octet-stream' && (originalname.toLowerCase().endsWith('.docx') || originalname.toLowerCase().endsWith('.doc')) ||
        originalname.toLowerCase().endsWith('.docx') ||
        originalname.toLowerCase().endsWith('.doc');

      if (mimetype === 'application/pdf') {
        if (!pdf) {
          throw new Error('Máy chủ chưa sẵn sàng xử lý PDF');
        }
        const data = await pdf(buffer);
        content = data.text || '';
      } else if (isWord) {
        try {
          const result = await mammoth.extractRawText({ buffer });
          content = result.value;
          if (result.messages && result.messages.length > 0) {
            console.log('[API] Mammoth messages:', result.messages);
          }
        } catch (wordErr: any) {
          console.error('[API] Mammoth error:', wordErr);
          // If it's a binary .doc file, mammoth will fail. 
          // For now, we only support .docx effectively with mammoth.
          if (originalname.toLowerCase().endsWith('.doc') && !originalname.toLowerCase().endsWith('.docx')) {
            throw new Error('Định dạng .doc (cũ) không được hỗ trợ tốt. Vui lòng chuyển sang .docx');
          }
          throw wordErr;
        }
      } else if (mimetype.startsWith('text/')) {
        content = buffer.toString('utf-8');
      } else if (mimetype.startsWith('image/')) {
        type = 'image';
        data_base64 = buffer.toString('base64');
      } else {
        console.warn(`[API] Unsupported type: ${mimetype}`);
        return res.status(400).json({ error: `Định dạng file không hỗ trợ: ${mimetype}` });
      }

      // Truncate content to fit Firestore 1MB limit (leaving room for metadata)
      if (type === 'text' && content.length > 950000) {
        console.log(`[API] Truncating large content from ${content.length} characters`);
        content = content.substring(0, 950000) + '\n\n[Nội dung đã bị cắt bớt do quá dài...]';
      }
    } catch (procErr: any) {
      console.error('[API] Parse error:', procErr);
      throw new Error(`Lỗi đọc nội dung file: ${procErr.message}`);
    }

    const newDoc = {
      id: Math.random().toString(36).substring(2, 11),
      name: originalname,
      type,
      content: type === 'text' ? content : undefined,
      data: type === 'image' ? data_base64 : undefined,
      mimeType: mimetype,
      uploadDate: new Date().toLocaleDateString('vi-VN'),
    };

    cachedDocuments.push(newDoc);
    await syncToDisk();
    
    console.log(`[API] Success: ${newDoc.id}`);
    res.json(newDoc);
  } catch (error: any) {
    console.error('[API] Global process error:', error);
    res.status(500).json({ error: error.message || 'Lỗi xử lý tài liệu' });
  }
});

// Delete document
apiRouter.delete('/documents/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`[API] Deleting doc: ${id}`);
  const initialLength = cachedDocuments.length;
  cachedDocuments = cachedDocuments.filter((d: any) => d.id !== id);
  
  if (cachedDocuments.length !== initialLength) {
    await syncToDisk();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Không tìm thấy tài liệu' });
  }
});

// Health check
apiRouter.get('/health', (req, res) => {
  res.json({ status: 'ok', docs: cachedDocuments.length });
});

// Mount API router
app.use('/api', apiRouter);

// Catch-all API 404
app.all('/api/*', (req, res) => {
  console.warn(`[API] 404: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'API endpoint not found' });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Global Error]:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

async function startServer() {
  console.log('[Server] Starting up...');
  
  // Load PDF library
  try {
    const pdfModule = require('pdf-parse');
    pdf = pdfModule.default || pdfModule;
    console.log('[Server] PDF library loaded.');
  } catch (e) {
    console.error('[Server] PDF library load failure:', e);
  }

  await initializeStorage();

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Server] Running in development mode with Vite.');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('[Server] Running in production mode.');
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('[Server] Critical boot failure:', err);
});

