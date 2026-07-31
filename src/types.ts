export interface Document {
  id: string;
  name: string;
  type: 'text' | 'image';
  content?: string;
  data?: string; // base64 for images
  mimeType?: string;
  uploadDate: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}
