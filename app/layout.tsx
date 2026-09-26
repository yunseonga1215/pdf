import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Note — 내 파일, 내 폴더에',
  description: '파일을 업로드하고 내가 선택한 폴더에 안전하게 저장하세요.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
