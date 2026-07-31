import React, { useState, useRef, useEffect } from 'react';
import { 
  Send, 
  Upload, 
  FileText, 
  Image as ImageIcon, 
  Trash2, 
  MessageSquare, 
  BookOpen, 
  Plus, 
  ChevronRight, 
  History as HistoryIcon, 
  Menu, 
  X,
  FileUp,
  ShieldCheck,
  Flag,
  Database,
  Globe,
  Layers,
  RotateCcw,
  Copy,
  Check,
  Key,
  Settings
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import { GoogleGenAI } from "@google/genai";
import mammoth from 'mammoth';
import { Document, Message } from './types.ts';
import { db, auth } from './lib/firebase.ts';
import { 
  collection, 
  getDocs, 
  addDoc, 
  deleteDoc, 
  doc, 
  query, 
  orderBy, 
  onSnapshot,
  setDoc,
  serverTimestamp,
  getDocFromServer
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.warn('Firestore Notice: ', JSON.stringify(errInfo));
  return errInfo;
}

const SYSTEM_INSTRUCTION = `
Danh tính: Bạn là "Trợ lý Nghiệp vụ Đảng" thông thái, chính xác và cẩn trọng.
Nhiệm vụ: Giải đáp các câu hỏi về Điều lệ Đảng, Quy định thi hành Điều lệ, các Hướng dẫn của Ban Tổ chức Trung ương, Ủy ban Kiểm tra Trung ương và các Nghị quyết cấp trên.

Nguyên tắc trình bày Markdown:
1. Trình bày khoa học: Sử dụng tiêu đề (###) cho các mục lớn. Tránh lạm dụng tiêu đề nhỏ (####).
2. Tối giản in đậm: Chỉ in đậm (**) các từ khóa quan trọng nhất hoặc tên văn bản quy phạm pháp luật. Không in đậm cả câu.
3. Sử dụng danh sách: Ưu tiên dùng dấu gạch đầu dòng (-) cho các ý liệt kê để nội dung thoáng đãng.
4. Khoảng cách: Luôn để cách một dòng giữa các đoạn văn hoặc các mục tiêu đề.
5. Căn cứ pháp lý: Luôn nêu rõ nguồn văn bản (số hiệu, ngày ban hành, cơ quan ban hành).

Phong cách: Nghiêm túc, chuẩn mực, chính xác nhưng dễ đọc, dễ hiểu.
`;

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatHistory, setChatHistory] = useState<any[]>([]); // To store past conversations
  const [documents, setDocuments] = useState<Document[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [searchMode, setSearchMode] = useState<'internal' | 'internet' | 'both'>('internal');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [userApiKey, setUserApiKey] = useState(() => localStorage.getItem('GEMINI_API_KEY') || '');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const migrationStarted = useRef(false);
  const [user, setUser] = useState<User | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);

  const getApiKey = () => {
    const customKey = (localStorage.getItem('GEMINI_API_KEY') || userApiKey || '').trim();
    if (customKey && customKey.length > 10) return customKey;

    const envKey = (process.env.TrolyDang_API_Key || process.env.GEMINI_API_KEY || "").trim();
    if (envKey && envKey.length > 10 && !envKey.includes('MY_') && !envKey.includes('YOUR_')) return envKey;

    return '';
  };

  // Initialize data on load
  useEffect(() => {
    // Auth listener
    const authUnsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthChecking(false);
    });

    // Real-time listener for Firestore documents
    const documentsRef = collection(db, 'documents');
    const unsubscribe = onSnapshot(documentsRef, (snapshot) => {
      // Avoid flickering by ignoring local optimistic updates if server hasn't confirmed
      if (snapshot.metadata.hasPendingWrites && documents.length > 0) return;

      const docs: Document[] = [];
      snapshot.forEach((docSnap) => {
        docs.push({ ...docSnap.data() } as Document);
      });
      
      // Sort and update state
      setDocuments(docs.sort((a, b) => b.uploadDate.localeCompare(a.uploadDate)));
      
      // If Firestore is empty or has fewer docs than local, trigger sync
      // But only if we haven't already started a migration in this session
      if (!migrationStarted.current) {
        migrationStarted.current = true;
        syncLocalDocumentsWithFirestore(docs);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'documents');
    });

    loadHistory();
    
    // Initial welcome if no messages
    const savedMessages = localStorage.getItem('current_convo');
    if (savedMessages) {
      setMessages(JSON.parse(savedMessages));
    } else {
      setMessages([{
        id: '1',
        role: 'assistant',
        content: 'Xin chào đồng chí! Tôi là Trợ lý Nghiệp vụ Đảng AI. Tôi sẵn sàng hỗ trợ đồng chí tra cứu quy định và giải đáp các nghiệp vụ về công tác Đảng. Đồng chí có thể tải lên tài liệu để tôi hỗ trợ chính xác hơn.',
        timestamp: new Date().toLocaleTimeString(),
      }]);
    }

    return () => {
      unsubscribe();
      authUnsubscribe();
    };
  }, []);

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('Login error:', error);
      alert('Không thể đăng nhập. Vui lòng thử lại.');
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const syncLocalDocumentsWithFirestore = async (existingFirestoreDocs: Document[]) => {
    // Only attempt sync if user is logged in (otherwise permissions will fail)
    if (!auth.currentUser) return;
    try {
      const response = await fetch('/api/documents');
      if (response.ok) {
        const localDocs: Document[] = await response.json();
        if (localDocs && localDocs.length > 0) {
          const firestoreIds = new Set(existingFirestoreDocs.map(d => d.id));
          
          let migratedCount = 0;
          for (const docData of localDocs) {
            // Only upload if it doesn't exist in Firestore
            if (!firestoreIds.has(docData.id)) {
              await setDoc(doc(db, 'documents', docData.id), docData);
              migratedCount++;
            }
          }
          
          if (migratedCount > 0) {
            console.log(`[Sync] Migrated ${migratedCount} new documents to Firestore.`);
          }
        }
      }
    } catch (err) {
      console.warn('[Sync] Failed to check for local docs:', err);
    }
  };

  // Save conversation to local storage
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem('current_convo', JSON.stringify(messages));
    }
  }, [messages]);

  // Scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchDocuments = async () => {
    // Handled by onSnapshot
  };

  const loadHistory = () => {
    const savedHistory = localStorage.getItem('chat_history');
    if (savedHistory) {
      setChatHistory(JSON.parse(savedHistory));
    }
  };

  const saveToHistory = () => {
    if (messages.length <= 1) return;
    
    const newHistoryItem = {
      id: Date.now(),
      title: messages[1]?.content.substring(0, 30) + '...',
      date: new Date().toLocaleDateString('vi-VN'),
      messages: [...messages]
    };
    
    const updatedHistory = [newHistoryItem, ...chatHistory.slice(0, 9)];
    setChatHistory(updatedHistory);
    localStorage.setItem('chat_history', JSON.stringify(updatedHistory));
    
    // Clear current chat
    setMessages([{
      id: '1',
      role: 'assistant',
      content: 'Đã lưu vào lịch sử. Tôi có thể giúp gì tiếp cho đồng chí?',
      timestamp: new Date().toLocaleTimeString(),
    }]);
    localStorage.removeItem('current_convo');
  };

  const loadHistoryItem = (item: any) => {
    setMessages(item.messages);
    setShowHistory(false);
  };

  const handleCopyMessage = (content: string, id: string) => {
    navigator.clipboard.writeText(content).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    }).catch(err => {
      console.error('Không thể sao chép văn bản: ', err);
    });
  };

  const parseFileClientSide = async (file: File): Promise<Document> => {
    const fileName = file.name;
    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    let content = '';

    if (['txt', 'md', 'json', 'csv', 'xml', 'html', 'log'].includes(ext)) {
      content = await file.text();
    } else if (ext === 'docx' || ext === 'doc') {
      try {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        content = result.value;
      } catch (err) {
        console.warn('Mammoth extraction failed:', err);
        content = await file.text().catch(() => `Tài liệu Word: ${fileName}`);
      }
    } else if (ext === 'pdf') {
      try {
        const buffer = await file.arrayBuffer();
        const textDecoder = new TextDecoder('utf-8', { fatal: false });
        const rawText = textDecoder.decode(buffer);
        const matches = rawText.match(/[\x20-\x7E\xA0-\xFF\u0100-\u017F\u0180-\u024F\u1EA0-\u1EF9\n\r\t]+/g);
        if (matches && matches.join(' ').length > 100) {
          content = matches.join(' ').replace(/\s+/g, ' ');
        } else {
          content = `Nội dung tài liệu PDF: ${fileName} (Đã thêm vào kho nghiệp vụ).`;
        }
      } catch {
        content = `Tài liệu PDF: ${fileName}`;
      }
    } else {
      content = await file.text().catch(() => `Tài liệu: ${fileName}`);
    }

    return {
      id: Date.now().toString(),
      name: fileName,
      type: 'text',
      uploadDate: new Date().toLocaleString('vi-VN'),
      content: content.trim() || `Nội dung tài liệu ${fileName}`
    };
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!user) {
      alert('Báo cáo đồng chí: Cần đăng nhập để thực hiện tải tài liệu lên kho nghiệp vụ. Vui lòng bấm "CẤP QUYỀN" và thử lại.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setIsProcessingFile(true);
    let newDoc: Document | null = null;

    try {
      // 1. Try server endpoint first if running with backend
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch('/api/process-file', {
          method: 'POST',
          body: formData,
        });

        if (response.ok) {
          newDoc = await response.json();
        }
      } catch (err) {
        console.warn('Server process-file endpoint unavailable, using client-side fallback:', err);
      }

      // 2. Client-side fallback if server route is missing or fails (e.g. on GitHub Pages)
      if (!newDoc) {
        newDoc = await parseFileClientSide(file);
      }

      if (newDoc) {
        try {
          await setDoc(doc(db, 'documents', newDoc.id), newDoc);
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `documents/${newDoc.id}`);
        }
      }
    } catch (error: any) {
      console.error('Error uploading file:', error);
      let msg = error.message;
      try {
        const parsed = JSON.parse(error.message);
        if (parsed.error && parsed.error.includes('permissions')) {
          msg = 'Đồng chí cần đăng nhập để tải lên tài liệu nghiệp vụ.';
        }
      } catch {
        // Not a JSON error
      }
      alert(`Có lỗi xảy ra khi xử lý tài liệu: ${msg}`);
    } finally {
      setIsProcessingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const removeDocument = async (id: string) => {
    if (!user) {
      alert('Đồng chí cần đăng nhập để thực hiện thao tác này.');
      return;
    }
    try {
      // Delete from Firestore
      try {
        await deleteDoc(doc(db, 'documents', id));
      } catch (error) {
        handleFirestoreError(error, OperationType.DELETE, `documents/${id}`);
      }
      
      // Also notify server to delete from its local cache if server is running
      try {
        await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      } catch { /* ignore server 404 on static hosting */ }
    } catch (error: any) {
      console.error('Error deleting document:', error);
      let msg = error.message;
      try {
        const parsed = JSON.parse(error.message);
        if (parsed.error && parsed.error.includes('permissions')) {
          msg = 'Đồng chí không có quyền xóa tài liệu này. Vui lòng đăng nhập tài khoản có thẩm quyền.';
        }
      } catch { /* ignore */ }
      alert(`Lỗi: ${msg}`);
    }
  };

  const handleResend = (content: string) => {
    handleSendMessage(content);
  };

  const handleSendMessage = async (overrideInput?: string | React.MouseEvent) => {
    let textToSend: string;
    
    if (typeof overrideInput === 'string') {
      textToSend = overrideInput;
    } else {
      textToSend = input;
    }

    if (!textToSend || typeof textToSend !== 'string' || !textToSend.trim() || isLoading) return;
    
    const finalInput = textToSend.trim();

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: finalInput,
      timestamp: new Date().toLocaleTimeString(),
    };

    setMessages(prev => [...prev, userMessage]);
    if (typeof overrideInput !== 'string') setInput('');
    setIsLoading(true);

    try {
      // Prepare context from documents based on search mode
      let textContext = '';
      if (searchMode === 'internal' || searchMode === 'both') {
        textContext = documents
          .filter(doc => doc.type === 'text')
          .map(doc => `[Tài liệu: ${doc.name}]\n${doc.content}`)
          .join('\n\n---\n\n');
      }

      // Build search mode guidance
      let modeGuidance = '';
      if (searchMode === 'internet') {
        modeGuidance = 'CHÚ Ý: Chỉ sử dụng kiến thức từ Internet, ưu tiên các nguồn văn bản chính quy, tin cậy của Đảng và Nhà nước. Nếu không tìm thấy thông tin chính thống, hãy báo cáo rõ.';
      } else if (searchMode === 'internal') {
        modeGuidance = 'CHÚ Ý QUAN TRỌNG: Đồng chí ĐANG Ở CHẾ ĐỘ NỘI BỘ. Chỉ được phép dựa vào kho tài liệu nội bộ đã được cung cấp ở trên. Tuyệt đối không tự ý dùng kiến thức ngoài hoặc tự suy diễn nếu tài liệu không nhắc tới. Nếu tài liệu không có thông tin, hãy trả lời: "Báo cáo đồng chí, trong kho tài liệu nội bộ hiện tại không có dữ liệu về vấn đề này."';
      } else {
        modeGuidance = 'CHÚ Ý: Tổng hợp thông tin từ cả kho tài liệu nội bộ và các nguồn tin cậy trên Internet. Nếu có mâu thuẫn, hãy ưu tiên thông tin từ tài liệu nội bộ.';
      }

      // Add context to the latest question
      const userParts: any[] = [];
      if (textContext) {
        userParts.push({ text: `Dưới đây là nội dung từ kho tài liệu nghiệp vụ công tác Đảng để đồng chí tham khảo:\n${textContext}` });
      }

      userParts.push({ text: `${modeGuidance}\n\nCâu hỏi: ${finalInput}` });

      const apiKey = getApiKey();
      
      if (!apiKey) {
        setShowKeyModal(true);
        setIsLoading(false);
        setMessages(prev => [...prev, {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: 'Báo cáo đồng chí: Hệ thống chưa phát hiện **Gemini API Key**. Đồng chí vui lòng bấm nút **🔑 Khóa API** góc trên bên phải để thiết lập API Key.',
          timestamp: new Date().toLocaleTimeString(),
        }]);
        return;
      }

      const history = messages.slice(1).map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

      let responseText = '';

      // 1. Try server proxy endpoint first if running on fullstack container
      try {
        const serverRes = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messages.slice(1).map(m => ({ role: m.role, content: m.content })).concat([{ role: 'user', content: userParts.map((p: any) => p.text).join('\n') }]),
            systemInstruction: SYSTEM_INSTRUCTION
          })
        });
        if (serverRes.ok) {
          const data = await serverRes.json();
          if (data.text) {
            responseText = data.text;
          }
        }
      } catch {
        // Ignored on static hosting (e.g. GitHub Pages)
      }

      // 2. Client-side direct REST API call if server proxy was unavailable
      if (!responseText) {
        const modelsToTry = [
          "gemini-2.5-flash",
          "gemini-2.0-flash",
          "gemini-1.5-flash",
          "gemini-2.5-pro"
        ];

        let lastErr: any = null;

        for (const modelName of modelsToTry) {
          try {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
            const payload = {
              systemInstruction: {
                parts: [{ text: SYSTEM_INSTRUCTION }]
              },
              contents: [
                ...history,
                { role: 'user', parts: userParts }
              ]
            };

            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              const msg = errBody.error?.message || `HTTP ${res.status}`;
              throw new Error(msg);
            }

            const resData = await res.json();
            const textCandidate = resData?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (textCandidate) {
              responseText = textCandidate;
              break;
            }
          } catch (err: any) {
            console.warn(`[REST] Model ${modelName} failed:`, err?.message || err);
            lastErr = err;
          }
        }

        if (!responseText && lastErr) {
          throw lastErr;
        }
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: responseText || 'Xin lỗi, tôi không thể trả lời câu hỏi này lúc này.',
        timestamp: new Date().toLocaleTimeString(),
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error('Chat error:', error);
      let errorMessage = 'Đã xảy ra lỗi khi kết nối với hệ thống AI.';
      const errorMsg = error.message || String(error);

      if (errorMsg.includes('MISSING_API_KEY') || errorMsg.includes('401')) {
        errorMessage = 'Không tìm thấy API Key hợp lệ. Vui lòng bấm vào nút 🔑 Khóa API ở góc trên để cấu hình Gemini API Key.';
      } else if (errorMsg.includes('429')) {
        errorMessage = 'Hệ thống AI đang quá tải hoặc hết hạn mức (Quota exceeded). Vui lòng thử lại sau giây lát.';
      } else if (errorMsg.includes('404')) {
        errorMessage = 'Không tìm thấy mô hình AI được yêu cầu (Model not found). Đang cập nhật hệ thống...';
      } else {
        errorMessage = `Lỗi hệ thống: ${errorMsg}`;
      }

      setMessages(prev => [...prev, {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: errorMessage,
        timestamp: new Date().toLocaleTimeString(),
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-[#F4F1ED] font-sans text-[#212529] overflow-hidden">
      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {!isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(true)}
            className="fixed inset-0 bg-black/20 z-20 md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar - Kho tài liệu */}
      <motion.aside 
        initial={false}
        animate={{ width: isSidebarOpen ? '320px' : '0px', opacity: isSidebarOpen ? 1 : 0 }}
        className="bg-white border-r border-[#E5E7EB] flex flex-col z-30 overflow-hidden shadow-sm h-full"
      >
        <div className="p-5 border-b border-[#E5E7EB] flex items-center justify-between bg-[#DA251D] text-white">
          <div className="flex items-center gap-2">
            <BookOpen size={20} className="text-[#FFFF00]" />
            <h2 className="font-bold tracking-tight uppercase text-sm font-serif">Kho tài liệu</h2>
          </div>
          <div className="flex items-center gap-2">
            {user ? (
               <button onClick={logout} className="text-[10px] bg-white/20 hover:bg-white/30 px-2 py-1 rounded transition-colors" title={`Đăng xuất: ${user.email}`}>
                 Đăng xuất
               </button>
            ) : (
               <button onClick={login} className="text-[10px] bg-[#FFFF00] text-[#DA251D] font-bold px-2 py-1 rounded shadow hover:bg-yellow-100 transition-colors">
                 Cấp quyền
               </button>
            )}
            <button onClick={() => setIsSidebarOpen(false)} className="md:hidden">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-[#FAF9F6]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] uppercase font-bold text-[#6B7280] tracking-widest">Danh sách ({documents.length})</span>
            <button 
              onClick={() => fileInputRef.current?.click()}
              disabled={isProcessingFile}
              className="flex items-center gap-1 text-[11px] font-bold text-[#DA251D] hover:underline disabled:opacity-50"
            >
              <Plus size={14} /> THÊM MỚI
            </button>
            <input 
              type="file" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              className="hidden" 
              accept=".pdf,.doc,.docx,.txt,image/*"
            />
          </div>

          <div className="space-y-2">
            {documents.length === 0 ? (
              <div className="text-center py-10 opacity-40">
                <FileUp size={32} className="mx-auto mb-2" />
                <p className="text-xs">Chưa có tài liệu nghiệp vụ</p>
              </div>
            ) : (
              documents.map(doc => (
                <motion.div 
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  key={doc.id}
                  className="group flex items-start gap-3 p-3 bg-white border border-[#E5E7EB] rounded-xl hover:shadow-md transition-all cursor-default"
                >
                  <div className={`p-2 rounded-lg ${doc.type === 'text' ? 'bg-blue-50 text-blue-600' : 'bg-orange-50 text-orange-600'}`}>
                    {doc.type === 'text' ? <FileText size={16} /> : <ImageIcon size={16} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium truncate mb-0.5">{doc.name}</p>
                    <p className="text-[10px] text-[#9CA3AF]">{doc.uploadDate}</p>
                  </div>
                  <button 
                    onClick={() => removeDocument(doc.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-[#EF4444] hover:bg-red-50 rounded"
                  >
                    <Trash2 size={14} />
                  </button>
                </motion.div>
              ))
            )}
          </div>
        </div>

          <div className="p-4 border-t border-[#E5E7EB] bg-white text-[10px] space-y-2">
            {user && (
              <div className="flex items-center gap-2 text-green-600 mb-1">
                <ShieldCheck size={12} />
                <span className="truncate max-w-[200px]">Đã đăng nhập: {user.email}</span>
              </div>
            )}
            <div className="text-center text-[#6B7280]">
              Kho tài liệu nghiệp vụ dùng chung & lưu trữ vĩnh viễn
            </div>
          </div>
        </motion.aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative h-full">
        {/* Header */}
        <header className="h-16 bg-white border-b border-[#E5E7EB] flex items-center justify-between px-4 md:px-6 z-10 shadow-sm">
          <div className="flex items-center gap-3">
            {!isSidebarOpen && (
              <button onClick={() => setIsSidebarOpen(true)} className="p-2 hover:bg-[#F3F4F6] rounded-lg transition-colors">
                <Menu size={20} />
              </button>
            )}
            <div className="w-10 h-10 bg-[#DA251D] rounded-full flex items-center justify-center p-1 shadow-sm">
              <Flag className="text-[#FFFF00]" size={20} />
            </div>
            <div>
              <h1 className="font-bold text-base md:text-xl text-[#DA251D] tracking-tight leading-tight uppercase font-serif">TRỢ LÝ NGHIỆP VỤ ĐẢNG AI</h1>
              <div className="flex items-center gap-1 text-[10px] text-[#059669]">
                <ShieldCheck size={10} />
                <span className="font-semibold uppercase tracking-wider">Hệ thống thông minh chuẩn mực</span>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-2 md:gap-4 text-xs font-medium text-[#6B7280]">
             <button 
              onClick={() => setShowKeyModal(true)}
              className="flex items-center gap-1 cursor-pointer hover:text-[#DA251D] transition-colors bg-amber-50 hover:bg-amber-100 text-amber-800 px-2 py-1 rounded-lg border border-amber-200 shadow-sm"
              title="Cấu hình Gemini API Key"
             >
                <Key size={14} className="text-amber-600" />
                <span className="font-bold text-[11px]">Khóa API</span>
             </button>
             <button 
              onClick={() => setShowHistory(!showHistory)}
              className="flex items-center gap-1 cursor-pointer hover:text-[#DA251D] transition-colors"
             >
                <HistoryIcon size={14} /> Lịch sử
             </button>
             <button 
              onClick={saveToHistory}
              className="text-[10px] px-2 py-0.5 bg-gray-100 rounded hover:bg-gray-200 hidden sm:inline"
             >
               Kết thúc & Lưu
             </button>
             <span className="w-px h-4 bg-[#E5E7EB] hidden sm:inline"></span>
             <span className="hidden md:flex items-center gap-1 text-[#DA251D]"><Flag size={14} /> Việt Nam</span>
          </div>
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6 relative">
          {/* History Overlay */}
          <AnimatePresence>
            {showHistory && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="absolute top-0 right-0 w-72 h-full bg-white shadow-2xl z-40 border-l border-[#E5E7EB] p-4 flex flex-col"
              >
                <div className="flex items-center justify-between mb-4 border-b pb-2">
                  <h3 className="font-bold text-xs uppercase tracking-tight">Lịch sử hội thoại</h3>
                  <button onClick={() => setShowHistory(false)}><X size={16} /></button>
                </div>
                <div className="flex-1 overflow-y-auto space-y-2">
                  {chatHistory.length === 0 ? (
                    <p className="text-[10px] text-gray-400 text-center py-10">Chưa có lịch sử</p>
                  ) : (
                    chatHistory.map((item) => (
                      <button 
                        key={item.id}
                        onClick={() => loadHistoryItem(item)}
                        className="w-full text-left p-3 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-100 transition-all"
                      >
                        <p className="text-[11px] font-bold truncate">{item.title}</p>
                        <p className="text-[10px] text-gray-400">{item.date}</p>
                      </button>
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={`flex gap-3 max-w-[85%] md:max-w-[70%] ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center shadow-sm ${
                    m.role === 'user' ? 'bg-amber-100' : 'bg-[#DA251D]'
                  }`}>
                    {m.role === 'user' ? <Plus size={16} className="text-amber-700" /> : <Flag size={16} className="text-[#FFFF00]" />}
                  </div>
                  <div className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className={`px-4 py-3 rounded-2xl shadow-sm border ${
                      m.role === 'user' 
                        ? 'bg-amber-600 text-white border-amber-700 rounded-tr-none' 
                        : 'bg-white border-[#E5E7EB] text-[#212529] rounded-tl-none'
                    }`}>
                      {m.role === 'user' ? (
                        <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{m.content}</p>
                      ) : (
                        <div className="markdown-container prose prose-sm max-w-none text-[14px] leading-relaxed">
                          <ReactMarkdown>{m.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1.5 px-1">
                      <span className="text-[10px] text-[#9CA3AF] uppercase font-bold tracking-tight">
                        {m.role === 'user' ? 'Đồng chí' : 'Trợ lý'} • {m.timestamp}
                      </span>
                      {m.role === 'user' && (
                        <button 
                          onClick={() => handleResend(m.content)}
                          title="Hỏi lại câu này"
                          className="p-1 text-[#9CA3AF] hover:text-[#DA251D] hover:bg-[#DA251D]/10 rounded-full transition-all"
                        >
                          <RotateCcw size={10} />
                        </button>
                      )}
                      {m.role === 'assistant' && (
                        <button 
                          onClick={() => handleCopyMessage(m.content, m.id)}
                          title="Sao chép câu trả lời"
                          className={`p-1 rounded-full transition-all flex items-center gap-1 ${
                            copiedId === m.id 
                              ? 'text-green-600 bg-green-50' 
                              : 'text-[#9CA3AF] hover:text-[#DA251D] hover:bg-[#DA251D]/10'
                          }`}
                        >
                          {copiedId === m.id ? (
                            <>
                              <Check size={10} />
                              <span className="text-[8px] font-bold">ĐÃ CHÉP</span>
                            </>
                          ) : (
                            <Copy size={10} />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
            {isLoading && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex justify-start"
              >
                <div className="flex gap-3 items-center bg-white px-4 py-3 rounded-2xl shadow-sm border border-[#E5E7EB] rounded-tl-none">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-[#DA251D]/60 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1.5 h-1.5 bg-[#DA251D]/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1.5 h-1.5 bg-[#DA251D]/60 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </div>
                  <span className="text-xs italic text-[#6B7280]">Đang tra cứu cơ sở dữ liệu...</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div ref={chatEndRef} />
        </div>

        {/* Source Selection - Floating above input */}
      <div className="max-w-4xl mx-auto px-4 mb-2">
        <div className="flex items-center gap-2 bg-white/80 backdrop-blur-sm p-1 rounded-lg border border-gray-100 shadow-sm inline-flex">
          <button
            id="source-internal"
            onClick={() => setSearchMode('internal')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              searchMode === 'internal' 
                ? 'bg-red-600 text-white shadow-sm' 
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Database size={14} />
            Nội bộ
          </button>
          <button
            id="source-internet"
            onClick={() => setSearchMode('internet')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              searchMode === 'internet' 
                ? 'bg-red-600 text-white shadow-sm' 
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Globe size={14} />
            Internet
          </button>
          <button
            id="source-both"
            onClick={() => setSearchMode('both')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              searchMode === 'both' 
                ? 'bg-red-600 text-white shadow-sm' 
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            <Layers size={14} />
            Cả hai
          </button>
        </div>
      </div>

      {/* Input Area */}
        <div className="p-4 md:p-6 bg-white border-t border-[#E5E7EB]">
          <div className="max-w-4xl mx-auto relative">
            <div className={`flex items-end gap-3 p-2 bg-[#F9FAFB] border-2 rounded-2xl transition-all ${
              input.trim() ? 'border-amber-200 shadow-inner' : 'border-[#E5E7EB]'
            }`}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Nhập câu hỏi về nghiệp vụ hoặc văn bản Đảng..."
                className="flex-1 bg-transparent border-none focus:ring-0 resize-none py-2 px-3 text-[14px] min-h-[44px] max-h-40 font-medium"
                rows={1}
              />
              <button
                onClick={handleSendMessage}
                disabled={!input.trim() || isLoading}
                className={`px-6 py-3 rounded-xl flex items-center gap-2 transition-all shadow-md ${
                  input.trim() && !isLoading
                    ? 'bg-[#DA251D] text-white hover:bg-[#B91C1C] hover:-translate-y-0.5'
                    : 'bg-[#F3F4F6] text-[#9CA3AF] cursor-not-allowed shadow-none'
                }`}
              >
                <span className="font-bold uppercase tracking-wide">Hỏi</span>
                <Send size={18} />
              </button>
            </div>
            
            {/* Quick Tips */}
            <div className="flex flex-wrap gap-2 mt-3">
              <span className="text-[10px] text-[#6B7280] font-bold uppercase py-1">Gợi ý:</span>
              <button 
                id="tip-ketnap"
                onClick={() => handleSendMessage("Hướng dẫn quy trình kết nạp Đảng viên mới?")}
                className="text-[11px] px-3 py-1 bg-white border border-[#E5E7EB] rounded-full hover:bg-[#F3F4F6] transition-colors"
              >
                Quy trình kết nạp?
              </button>
              <button 
                id="tip-kyluat"
                onClick={() => handleSendMessage("Các hình thức kỷ luật đối với Đảng viên?")}
                className="text-[11px] px-3 py-1 bg-white border border-[#E5E7EB] rounded-full hover:bg-[#F3F4F6] transition-colors"
              >
                Kỷ luật Đảng viên?
              </button>
              <button 
                id="tip-sinhhoat"
                onClick={() => handleSendMessage("Quy định về sinh hoạt chi bộ định kỳ?")}
                className="text-[11px] px-3 py-1 bg-white border border-[#E5E7EB] rounded-full hover:bg-[#F3F4F6] transition-colors"
              >
                Sinh hoạt chi bộ?
              </button>
            </div>
          </div>
        </div>

        {/* Processing Indicator Overlay */}
        <AnimatePresence>
          {isProcessingFile && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-white/60 backdrop-blur-[2px] z-20 flex items-center justify-center flex-col"
            >
              <div className="w-12 h-12 border-4 border-[#DA251D]/20 border-t-[#DA251D] rounded-full animate-spin mb-4" />
              <p className="font-bold text-[#DA251D] animate-pulse uppercase tracking-widest text-xs">Đang trích xuất nội dung văn bản...</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* API Key Modal */}
        <AnimatePresence>
          {showKeyModal && (
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-[#E5E7EB]"
              >
                <div className="flex items-center justify-between mb-4 border-b pb-3">
                  <h3 className="font-bold text-base text-[#DA251D] flex items-center gap-2 uppercase tracking-tight font-serif">
                    <Key size={18} className="text-amber-600" /> Cấu hình Gemini API Key
                  </h3>
                  <button onClick={() => setShowKeyModal(false)} className="text-gray-400 hover:text-gray-600 p-1">
                    <X size={18} />
                  </button>
                </div>
                <p className="text-xs text-gray-600 mb-4 leading-relaxed">
                  Thiết lập API Key giúp ứng dụng hoạt động 100% độc lập và ổn định khi xuất bản lên GitHub Pages hoặc lưu trữ tĩnh. Khóa được bảo mật và lưu trực tiếp trong trình duyệt của đồng chí.
                </p>
                <div className="mb-4">
                  <label className="block text-[11px] font-bold text-gray-700 uppercase tracking-wider mb-1">
                    Gemini API Key
                  </label>
                  <input
                    type="password"
                    value={userApiKey}
                    onChange={(e) => setUserApiKey(e.target.value)}
                    placeholder="AIzaSy..."
                    className="w-full border border-gray-300 rounded-xl p-3 text-sm focus:ring-2 focus:ring-[#DA251D] focus:outline-none bg-gray-50 font-mono"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <a 
                    href="https://aistudio.google.com/app/apikey" 
                    target="_blank" 
                    rel="noreferrer"
                    className="text-[11px] text-blue-600 hover:underline font-medium"
                  >
                    Lấy API Key miễn phí ↗
                  </a>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        localStorage.removeItem('GEMINI_API_KEY');
                        setUserApiKey('');
                        setShowKeyModal(false);
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-100"
                    >
                      Xóa khóa
                    </button>
                    <button
                      onClick={() => {
                        localStorage.setItem('GEMINI_API_KEY', userApiKey.trim());
                        setShowKeyModal(false);
                      }}
                      className="bg-[#DA251D] text-white px-4 py-2 rounded-xl font-bold text-xs uppercase hover:bg-red-700 transition-all shadow-md"
                    >
                      Lưu thay đổi
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
