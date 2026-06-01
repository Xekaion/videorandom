# 🎬 VIDEO ROULETTE (영상 랜덤 뽑기 프로그램)

<p align="center">
  <img src="https://img.shields.io/badge/Platform-Windows_10%2F11-blue?style=for-the-badge&logo=windows" alt="Platform Windows">
  <img src="https://img.shields.io/badge/Language-JavaScript%20%2F%20HTML5%20%2F%20CSS3-yellow?style=for-the-badge&logo=javascript" alt="Languages">
  <img src="https://img.shields.io/badge/Backend-Node.js%20%26%20Express-green?style=for-the-badge&logo=node.js" alt="Backend Node">
  <img src="https://img.shields.io/badge/Build-pkg%20Standalone-purple?style=for-the-badge" alt="Build Package">
</p>

---

## 🌌 Project Overview (프로젝트 소개)

> **"방대한 외장하드 속 영상들을 0.1초 만에 훑고, 미래지향적인 사이버 룰렛으로 오늘의 감상 영상을 골라보세요!"**

**Video Roulette**는 개인용 대용량 외장하드디스크 및 로컬 스토리지에 보관된 수많은 영상 파일들을 **비동기식 너비 우선 탐색(BFS)** 알고리즘으로 빠르게 스캔하여, 화려한 SF 영화 감성의 인터페이스를 통해 랜덤으로 영상을 추출해 주는 **오프라인 윈도우 단독 실행 프로그램**입니다. 

---

## ✨ Premium Features (핵심 기능)

### 1. 📂 윈도우 순정 폴더 찾아보기 (Native Folder Dialog)
* 입력창 옆 **`찾아보기(📁)` 아이콘 버튼**을 누르면, Windows 10/11의 순정 폴더 탐색기 대화상자가 즉시 실행됩니다. 
* 폴더나 디스크를 선택하는 순간 **자동으로 초고속 파일 인덱싱 스캔이 트리거**되어 극도로 편리합니다.

### ⚡ 2. 실시간 드라이브 감지 진행률 (% 표기)
* 프로그램이 켜지거나 새로고침될 때, 연결된 드라이브(C드라이브 및 외부 USB/외장하드디스크)를 **0%에서 100%까지 오르는 감속 로더와 체크 드라이브 문자(C:\, D:\ 등)**로 세련되게 알려줍니다.

### 🔗 3. 다중 디스크 묶음 일괄 스캔 (Multi-Disk scan)
* `C:\`, `D:\`, `E:\` 등 화면에 감지된 드라이브 카드를 **마우스로 중복 클릭하여 원하는 만큼 묶어서 한 번에 인덱싱**할 수 있습니다. 
* 다중 경로 병렬 BFS 스캔을 거쳐 모든 스토리지의 영상을 단 한 장의 통합 룰렛으로 돌릴 수 있습니다.

### 🎰 4. 사이버 틱 장치 & 감속 룰렛 피드백
* 클릭과 동시에 사이버 레이저 사운드 및 입자가 폭발하는 물리엔진 연출이 펼쳐집니다.
* 실제 슬롯머신처럼 **점진적 마찰력 감속 알고리즘**이 탑재되어, 룰렛의 속도가 점차 늦어지며 긴장감 넘치게 당첨 파일을 엄선합니다.

### 🛠️ 5. 원클릭 탐색기 열기 & 기본 앱 즉시 재생
* 당첨된 파일의 **`즉시 재생하기`** 버튼을 누르면 Windows 시스템에 **기본 재생 플레이어로 즉시 동영상이 팝업 재생**됩니다.
* **`폴더 위치 열기`** 버튼을 누르면 띄어쓰기가 있는 복잡한 경로명이라도 완벽히 추적하여 **폴더를 열고 당첨된 파일을 정확히 파랗게 선택(하이라이트)**해 줍니다.

---

## 🎨 Technology Stack (기술 스택)

| 레이어 | 기술 및 라이브러리 | 용도 |
| :--- | :--- | :--- |
| **Frontend** | HTML5, Vanilla CSS3, Vanilla JS | 네온 Glassmorphism 테마 UI, 실시간 필터링 |
| **Sound FX** | Web Audio API | 신디사이저 합성 기반 효과음 (오프라인 무설정 구동) |
| **Backend** | Node.js, Express, Child Process | 폴더 선택창 호출, 탐색기 연동, 시스템 플레이어 제어 |
| **System Script**| PowerShell Automation (STA Mode)| Windows Forms Native 다이얼로그 바인딩 |
| **Build Compiler**| `pkg` binary compiler | 무설치 단일 독립 실행 파일 (`videorandom.exe`) 생성 |

---

## ⚙️ How to Run & Build (실행 및 개발자 가이드)

### 📥 1. 일반 사용자용 실행 (무설치 단독 버전)
1. 깃허브 최신 릴리즈 혹은 저장소 메인에 업로드되어 있는 **`videorandom.exe`**를 다운로드받습니다.
2. 실행하고 싶은 윈도우 PC 아무 곳에나 복사한 뒤, **더블 클릭하면 즉시 웹 앱과 연동되어 구동**됩니다!
> **Note**: 별도의 환경설정, Node.js 설치, 라이브러리 의존성이 일절 요구되지 않는 100% 무설치 포터블 버전입니다.

---

### 💻 2. 개발자용 로컬 환경 수동 구동 (Source Code)

#### **의존성 설치**
```bash
npm install
```

#### **서버 실행 (기본 브라우저 자동 연결)**
```bash
npm start
```
* 서버가 기동되는 즉시 기본 브라우저를 통해 `http://localhost:3000` 주소로 자동으로 창이 열립니다.

#### **단독 무설치 파일 (`videorandom.exe`) 컴파일 패키징**
```bash
npm run build
```
* 빌드 명령을 실행하면 프로젝트 루트 경로에 `videorandom.exe` 단독 바이너리가 컴파일 완료되어 출력됩니다.

---

## 📂 Project Structure (프로젝트 폴더 구조)

```text
videorandom/
├── public/                 # 프론트엔드 정적 파일
│   ├── css/
│   │   └── style.css       # 네온 사이버네틱 스타일 및 레이아웃
│   ├── js/
│   │   └── app.js          # 프론트엔드 비즈니스 로직 및 룰렛 시뮬레이션
│   └── index.html          # 메인 룰렛 인터페이스 마크업
├── server.js               # Express 핵심 백엔드 서버 및 Windows 네이티브 연동 API
├── package.json            # 의존성 및 빌드 스크립트 정의
├── run.bat                 # 윈도우용 일괄 자동 실행 배치 파일
└── README.md               # 한글 안내 설명서 (현재 파일)
```

---

## ⚠️ OS 호환성 및 예외 조치 알림

* **지원 파일 포맷**: `.mp4`, `.mkv`, `.wmv`, `.avi`, `.mpg`, `.mpeg`, `.asf`, `.flv`, `.webm`, `.mov`, `.3gp`, `.ts`, `.m4v`, `.tp`, `.m2ts` 등 현존하는 거의 모든 영상 포맷을 감지합니다.
* **절전 모드 외장하드 스캔 팁**: 장시간 미사용으로 절전(Sleep)에 빠진 대용량 외장하드의 경우, 드라이브 초기 반응에 시간이 지연될 수 있습니다. 이를 방지하기 위해 백엔드에 2초의 하드웨어 응답 타임아웃 방지 장치를 완비하여 서버 다운을 근본적으로 차단하였습니다.
* **폴더명 공백 호환성**: 모든 Windows 탐색기 연결 명령어는 파일 및 폴더 이름에 공백(띄어쓰기)이나 한글, 특수문자가 포함되어도 안전하게 따옴표 래핑 처리가 수행되어 실패 없이 견고히 작동합니다.

---

<p align="center">
  <b>Designed with passion, crafted for ultimate convenience.</b><br>
  &copy; 2026 Video Roulette Project. All Windows Native Automation Enabled.
</p>
