     import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
        import { getAuth, signInAnonymously, onAuthStateChanged, signOut, signInWithCustomToken } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
        import { getFirestore, collection, doc, addDoc, getDocs, onSnapshot, query, where, writeBatch, setDoc, deleteDoc, updateDoc, arrayUnion, Timestamp, getDoc, orderBy, limit, startAfter, deleteField } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

        let mermaidInitialized = false;
        const appState = {
            currentUser: null,
            currentView: 'login', // 'login', 'student', 'teacher'
            geminiApiKey: null,
            geminiModel: 'gemini-2.5-flash',
            assignments: [], // Holds the currently displayed list of assignments (paginated)
            allSubmissions: [],
            allClasses: [],
            calendarFilterDate: null,
            calendarDisplayDate: null,
            currentAssignment: null,
            currentPage: 1,
            currentArticlePage: 1,
            currentSelectionRange: null,
            isEventListenersInitialized: false,
            quizTimer: {
                startTime: null,
                intervalId: null,
                elapsedSeconds: 0
            },
            // New state for server-side pagination
            articleQueryState: {
                lastVisible: null, // Stores the last document snapshot for pagination
                isLoading: false,
                isLastPage: false,
                filters: {
                    format: '',
                    contentType: '',
                    difficulty: '',
                    status: ''
                }
            },
            teacherArticleQueryState: {
                lastVisible: null,
                isLoading: false,
                isLastPage: false,
                articles: [],
                filters: {
                    searchTerm: '',
                    format: '',
                    contentType: '',
                    difficulty: '',
                    deadlineStatus: ''
                }
            }
        };
        appState.cache = {
            assignments: null,
            lastFetch: 0,
        };
        const ARTICLES_PER_PAGE = 9;
        const TEACHER_PASSWORD_HASH = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918"; 

        // Centralized DOM element references for non-modal elements
        const dom = {
            appLoader: document.getElementById('app-loader'),
            loginView: document.getElementById('login-view'), 
            mainAppView: document.getElementById('main-app-view'),
            modalContainer: document.getElementById('modal-container'),
            highlightToolbar: document.getElementById('highlight-toolbar'),
        };
        const firebaseConfig = {
          apiKey: "AIzaSyB8uTu47VRp8WKnZ5QJ5IaVH1X2K2SJQwo",
          authDomain: "my-reading-platform.firebaseapp.com",
          projectId: "my-reading-platform",
          storageBucket: "my-reading-platform.firebasestorage.app",
          messagingSenderId: "200192012324",
          appId: "1:200192012324:web:fa181310ca103e269268b1"
        };
        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);
        const auth = getAuth(app);
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-reading-app-adventure-v2-full';

        async function callGenerativeAI(prompt) {
            if (!appState.geminiApiKey) {
                renderModal('message', { type: 'error', title: '設定錯誤', message: '尚未設定 Gemini API 金鑰，請夫子至「系統設定」頁面設定。' });
                throw new Error("Gemini API key is not set.");
            }
            
            const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${appState.geminiModel}:generateContent?key=${appState.geminiApiKey}`;

            const payload = {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.6,
                    topK: 1,
                    topP: 1,
                    maxOutputTokens: 8192,
                },
                 safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
                ]
            };

            const response = await fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorBody = await response.json();
                console.error("Gemini API Error:", errorBody);
                throw new Error(`API request failed with status ${response.status}`);
            }

            const body = await response.json();
            if (body.candidates && body.candidates.length > 0 && body.candidates[0].content && body.candidates[0].content.parts && body.candidates[0].content.parts.length > 0) {
                if (body.candidates[0].finishReason && body.candidates[0].finishReason !== "STOP") {
                    console.warn(`Gemini API response finished with reason: ${body.candidates[0].finishReason}. Full response:`, body);
                }
                return body.candidates[0].content.parts[0].text;
            } else {
                let errorMessage = "Invalid or empty 'candidates' in response from Gemini API.";
                if (body.promptFeedback) {
                    errorMessage = `Prompt was blocked. Reason: ${body.promptFeedback.blockReason}.`;
                    console.error("Gemini API Prompt Feedback:", body.promptFeedback);
                }
                console.error("Full API response:", body);
                throw new Error(errorMessage);
            }
        }

        async function callFullGeminiAnalysis(articleText) {
            const prompt = `
              你是一位專業的國文老師，擅長針對文章進行深入分析。請為以下文章提供三項資訊：

              文章內容：
              """
              ${articleText}
              """

              請嚴格按照以下 JSON 格式回傳，不要有任何其他的文字或解釋：
              {
                "mindmap": "一個 Mermaid.js 的 mindmap格式的心智圖。請確保語法絕對正確，擷取文章重點即可，節點不要過多，節點文字六字以內，第一層儘量不超過5個節點，第一層標上數字順序（如:①開頭），避免使用任何特殊字元或引號。",
                "explanation": "一篇 300 字左右的短文，對象是國中生，深入解析這篇文章的主旨、結構、寫作技巧與文化寓意。請使用 HTML 的 <p> 和 <strong> 標籤來組織段落與強調重點。不要長篇大論，要簡明易讀。",
                "thinking_questions": "一個 Markdown 格式的無序清單，提供三個與文章主題相關、能引導學生進行深度探究的思考題。問題應連結學生的生活經驗或引發思辨，且不應提供標準答案。不要長篇大論，要簡明易讀。例如：\\n* 根據文章，作者認為「勇敢」的定義是什麼？你生活中有沒有類似的經驗，讓你對「勇敢」有不同的看法？\\n* 文章中的主角做了一個困難的決定，如果換作是你，你會怎麼選擇？為什麼？"
              }
            `;
            
            const rawText = await callGenerativeAI(prompt);
            if (!rawText) return null;

            try {
                const cleanedText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
                return JSON.parse(cleanedText);
            } catch(e) {
                console.error("Failed to parse JSON from callGeminiAPI response:", e);
                console.error("Raw text received from AI:", rawText);
                throw new Error("AI did not return valid JSON.");
            }
        }
        async function callSingleGeminiAnalysis(articleText, target, action, originalContent = '', refinePrompt = '') {
            const targets = {
                mindmap: "一個 Mermaid.js 的 mindmap格式的心智圖。請確保語法絕對正確，擷取文章重點即可，節點不要過多，節點文字六字以內，第一層儘量不超過5個節點，第一層標上數字順序（如:①開頭），避免使用任何特殊字元或引號。",
                explanation: "一篇 300 字左右的短文，對象是國中生，深入解析這篇文章的主旨、結構、寫作技巧與文化寓意。請使用 HTML 的 <p> 和 <strong> 標籤來組織段落與強調重點。不要長篇大論，要簡明易讀。",
                thinking_questions: "一個 Markdown 格式的無序清單，提供三個與文章主題相關、能引導學生進行深度探究的思考題。問題應連結學生的生活經驗或引發思辨，且不應提供標準答案。不要長篇大論，要簡明易讀"
            };

            let actionInstruction;
            if (action === 'refine') {
                actionInstruction = `請根據以下使用者提供的版本進行潤飾。潤飾指令為：「${refinePrompt}」。\n原版本：\n"""\n${originalContent}\n"""`;
            } else { // regenerate
                actionInstruction = `請完全重新生成此內容。`;
            }

            const prompt = `
              你是一位專業的國文老師，擅長針對文章進行深入分析。請為以下文章提供指定的單一資訊。
              文章內容：
              """
              ${articleText}
              """
              
              請求的資訊類型：${targets[target]}

              操作指令：${actionInstruction}

              請直接回傳該項資訊的純文字內容，不要包含任何 JSON 格式或其他的標記。
            `;
            
            const rawContent = await callGenerativeAI(prompt);
            if (target === 'mindmap') {
                return rawContent.replace(/```mermaid/g, "").replace(/```/g, "").trim();
            }
            return rawContent;
        }
        // --- View Management ---
        function showView(viewName, data = {}) {
            dom.loginView.classList.add('hidden');
            dom.mainAppView.classList.add('hidden');
            dom.loginView.innerHTML = '';
            appState.currentView = viewName; // Update current view state
            
            // Dynamically apply background for the login page
            if (viewName === 'login' || viewName === 'error') {
                document.body.classList.add('login-background');
            } else {
                document.body.classList.remove('login-background');
            }

            if (viewName === 'login') {
                const template = document.getElementById('template-login-view');
                if (template) {
                    const content = template.content.cloneNode(true);
                    dom.loginView.appendChild(content);
                }
                dom.loginView.classList.remove('hidden');
            } else if (viewName === 'app') {
                dom.mainAppView.classList.remove('hidden');
                // Default to student view when app is shown
                switchViewTab('student');
            } else if (viewName === 'error') {
                dom.loginView.innerHTML = `<div class="card text-center text-red-600"><h2 class="text-xl font-bold">${data.title || '書院開啟失敗'}</h2><p>${data.message || '書院初始化或憑證驗證失敗，請刷新頁面或聯繫夫子。'}</p></div>`;
                dom.loginView.classList.remove('hidden');
            }
        }

        // --- Modal Management ---
        function closeModal() {
            const lastModal = dom.modalContainer.lastElementChild;
            if (lastModal) {
                lastModal.remove();
            }
        }

        function closeTopModal() {
            closeModal();
        }

        const modalHtmlGenerators = {
            _base: (content, zIndex = 50) => `<div class="modal-instance fixed inset-0 modal-backdrop flex items-center justify-center z-[${zIndex}] p-4">${content}</div>`,
            
            password(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-sm"><h2 class="text-xl font-bold mb-4 text-center font-rounded">夫子講堂</h2><input type="password" id="password-input" class="w-full form-element-ink mb-4" placeholder="請輸入憑信"><button id="password-submit-btn" class="w-full btn-primary py-2 font-bold">進入</button><p id="password-error" class="text-red-500 text-sm mt-2 text-center h-4"></p><button id="close-password-modal-btn" class="w-full mt-2 text-gray-500 hover:text-gray-700">返回</button></div>`;
                    resolve(this._base(content));
                });
            },

            result(data) {
                return new Promise(resolve => {
                    const scoreFeedback = data.score >= 90 ? "評價：甲上！" : data.score >= 70 ? "評價：甲！" : "評價：乙。";
                    const scoreColor = data.score >= 90 ? 'text-green-600' : data.score >= 70 ? 'text-amber-600' : 'text-red-600';

                    const reviewItems = data.assignment.questions.map((q, i) => {
                        const isCorrect = data.userAnswers[i] === q.correctAnswerIndex;
                        return el('div', { class: `p-4 rounded-lg mb-3 ${isCorrect ? 'bg-green-50' : 'bg-red-50'}` }, [
                            el('p', { class: 'font-semibold text-gray-800', textContent: `第 ${i + 1} 題: ${q.questionText}` }),
                            el('p', { class: 'mt-2 text-sm' }, [
                                '您的作答: ',
                                el('span', { class: 'font-medium', textContent: data.userAnswers[i] !== null ? q.options[data.userAnswers[i]] : '未作答' })
                            ]),
                            el('p', { class: 'mt-1 text-sm' }, [
                                '正解: ',
                                el('span', { class: 'font-medium', textContent: q.options[q.correctAnswerIndex] })
                            ]),
                            el('div', { class: 'mt-3 pt-3 border-t border-gray-200' }, [
                                el('p', { class: 'font-semibold text-red-800', textContent: '【淺解】' }),
                                el('p', { class: 'text-gray-600 text-sm mt-1', textContent: q.explanation || '暫無淺解。' })
                            ])
                        ]);
                    });

                    const content = el('div', { class: 'card max-w-2xl w-full' }, [
                        el('h2', { class: 'text-2xl font-bold mb-2 text-center text-amber-600 font-rounded', textContent: '課業完成' }),
                        el('p', { class: `text-5xl font-bold my-4 text-center ${scoreColor}`, textContent: data.score }),
                        el('p', { class: 'text-gray-600 mb-6 text-center', textContent: scoreFeedback }),
                        el('div', { class: 'text-left mb-6 max-h-[50vh] overflow-y-auto p-4 bg-gray-50 rounded-lg' }, reviewItems),
                        el('div', { class: 'flex gap-4 mt-6' }, [
                            el('button', { id: 'close-result-modal', class: 'w-full btn-secondary py-2 font-bold', textContent: '關閉' })
                        ])
                    ]);
                    
                    const base = this._base('', 50); // Create base structure with a placeholder
                    const baseElement = document.createElement('div');
                    baseElement.innerHTML = base;
                    baseElement.querySelector('.modal-backdrop').appendChild(content);
                    resolve(baseElement.innerHTML);
                });
            },

            aiAnalysis(data) {
                return new Promise(resolve => {
                    const content = `<div class="card max-w-3xl w-full"><h2 class="text-2xl font-bold mb-4 text-teal-700 flex items-center gap-2 font-rounded">AI 書僮點評</h2><div class="prose-custom max-h-[70vh] overflow-y-auto text-left p-4 bg-gray-50 rounded-lg">${markdownToHtml(data.analysisText)}</div><button id="close-ai-analysis-modal" class="mt-6 w-full btn-primary py-2 font-bold">展卷</button></div>`;
                    resolve(this._base(content));
                });
            },

            editArticle(data) {
                return new Promise(resolve => {
                    const assignment = data.assignment;
                    const deadline = assignment.deadline ? assignment.deadline.toDate().toISOString().split('T')[0] : '';
                    const tags = assignment.tags || {};

                    const createSelect = (id, options, label) => {
                        return el('div', {}, [
                            el('label', { class: 'text-sm font-medium text-gray-600', textContent: label }),
                            el('select', { id, class: 'w-full form-element-ink mt-1 text-sm' },
                                options.map(opt => el('option', { value: opt, textContent: `#${opt}` }))
                            )
                        ]);
                    };

                    const questionElementsHtml = assignment.questions.map((q, index) => {
                        const optionsHtml = q.options.map((opt, optIndex) => {
                            const isChecked = parseInt(q.correctAnswerIndex, 10) === optIndex;
                            return `<div class="flex items-center gap-2">
                                        <input type="radio" name="edit-correct-${index}" value="${optIndex}" ${isChecked ? 'checked' : ''}>
                                        <input type="text" class="edit-option w-full form-element-ink" value="${escapeHtml(opt)}">
                                    </div>`;
                        }).join('');

                        return `<div class="p-4 bg-gray-50 rounded-lg border" data-question-index="${index}">
                                    <div class="flex justify-between items-center mb-2">
                                        <label class="font-semibold">第 ${index + 1} 題</label>
                                        <button data-question-index="${index}" class="regenerate-question-btn btn-secondary py-1 px-3 text-xs">重新出題</button>
                                    </div>
                                    <textarea class="edit-question-text w-full form-element-ink mt-1" rows="2">${escapeHtml(q.questionText)}</textarea>
                                    <div class="mt-2 space-y-2">${optionsHtml}</div>
                                    <label class="font-semibold mt-2 block">淺解</label>
                                    <textarea class="edit-explanation w-full form-element-ink mt-1" rows="2">${escapeHtml(q.explanation)}</textarea>
                                </div>`;
                    }).join('');

                    const modalContent = el('div', { class: 'card max-w-4xl w-full' }, [
                        el('h2', { class: 'text-2xl font-bold mb-4 text-gray-800 font-rounded', textContent: '潤飾篇章' }),
                        el('div', { class: 'max-h-[80vh] overflow-y-auto custom-scrollbar pr-4' }, [
                            el('div', { class: 'space-y-4' }, [
                                el('div', { class: 'flex justify-between items-center' }, [
                                    el('h3', { class: 'font-bold', textContent: '篇章內容' }),
                                    el('button', { id: 'edit-ai-assistant-btn', class: 'btn-teal py-2 px-4 text-sm', textContent: 'AI 書僮' })
                                ]),
                                el('div', {}, [
                                    el('label', { class: 'font-bold', textContent: '標題' }),
                                    el('input', { type: 'text', id: 'edit-title', class: 'w-full form-element-ink mt-1', value: assignment.title })
                                ]),
                                el('div', {}, [
                                    el('label', { class: 'font-bold', textContent: '期限' }),
                                    el('input', { type: 'date', id: 'edit-deadline', class: 'w-full form-element-ink mt-1', value: deadline })
                                ]),
                               el('div', { class: 'form-check items-center flex gap-2 my-3' }, [
                                   el('input', {
                                       class: 'form-check-input w-5 h-5',
                                       type: 'checkbox',
                                       id: 'edit-is-public',
                                       // checked: !!assignment.isPublic,
                                       onclick: () => console.log('Checkbox clicked, new state:', document.getElementById('edit-is-public').checked)
                                   }),
                                   el('label', {
                                       class: 'form-check-label font-bold',
                                       htmlFor: 'edit-is-public',
                                       textContent: '將此篇章設為公開（學生可見）'
                                   })
                               ]),
                               el('textarea', { id: 'edit-article', rows: '10', class: 'w-full form-element-ink mt-1', textContent: assignment.article }),
                                
                                // AI Analysis Fields
                                el('div', { class: 'pt-4 border-t mt-4' }, [ el('h3', { class: 'font-bold', textContent: 'AI 深度解析 (可選)' }) ]),
                                el('div', { class: 'space-y-3 mt-2' }, [
                                    el('div', {}, [
                                        el('div', { class: 'flex justify-between items-center' }, [
                                            el('label', { class: 'font-semibold text-sm', textContent: '心智圖 (Mermaid 語法)'}),
                                            el('div', { class: 'flex gap-2' }, [
                                                el('button', { class: 'edit-analysis-ai-btn btn-secondary py-1 px-2 text-xs', 'data-action': 'refine', 'data-target': 'mindmap', textContent: 'AI 潤飾' }),
                                                el('button', { class: 'edit-analysis-ai-btn btn-secondary py-1 px-2 text-xs', 'data-action': 'regenerate', 'data-target': 'mindmap', textContent: '重新生成' })
                                            ])
                                        ]),
                                        el('textarea', { id: 'edit-analysis-mindmap', rows: '6', class: 'w-full form-element-ink mt-1 font-mono text-xs', textContent: (assignment.analysis && assignment.analysis.mindmap) || '' })
                                    ]),
                                    el('div', {}, [
                                        el('div', { class: 'flex justify-between items-center' }, [
                                            el('label', { class: 'font-semibold text-sm', textContent: '文章解析'}),
                                            el('div', { class: 'flex gap-2' }, [
                                                el('button', { class: 'edit-analysis-ai-btn btn-secondary py-1 px-2 text-xs', 'data-action': 'refine', 'data-target': 'explanation', textContent: 'AI 潤飾' }),
                                                el('button', { class: 'edit-analysis-ai-btn btn-secondary py-1 px-2 text-xs', 'data-action': 'regenerate', 'data-target': 'explanation', textContent: '重新生成' })
                                            ])
                                        ]),
                                        el('textarea', { id: 'edit-analysis-explanation', rows: '6', class: 'w-full form-element-ink mt-1', textContent: (assignment.analysis && assignment.analysis.explanation) || '' })
                                    ]),
                                    el('div', {}, [
                                        el('div', { class: 'flex justify-between items-center' }, [
                                            el('label', { class: 'font-semibold text-sm', textContent: '延伸思考 (Markdown 格式)'}),
                                            el('div', { class: 'flex gap-2' }, [
                                                el('button', { class: 'edit-analysis-ai-btn btn-secondary py-1 px-2 text-xs', 'data-action': 'refine', 'data-target': 'thinking_questions', textContent: 'AI 潤飾' }),
                                                el('button', { class: 'edit-analysis-ai-btn btn-secondary py-1 px-2 text-xs', 'data-action': 'regenerate', 'data-target': 'thinking_questions', textContent: '重新生成' })
                                            ])
                                        ]),
                                        el('textarea', { id: 'edit-analysis-thinking-questions', rows: '4', class: 'w-full form-element-ink mt-1', textContent: (assignment.analysis && assignment.analysis.thinking_questions) || '' })
                                    ])
                                ]),

                                el('div', { class: 'pt-4 border-t' }, [ el('h3', { class: 'font-bold', textContent: '分類' }) ]),
                                el('div', { class: 'grid grid-cols-1 md:grid-cols-3 gap-4' }, [
                                    createSelect('edit-tag-format', ['純文', '圖表', '圖文'], '形式'),
                                    createSelect('edit-tag-contentType', ['記敘', '抒情', '說明', '議論', '應用'], '內容'),
                                    createSelect('edit-tag-difficulty', ['簡單', '基礎', '普通', '進階', '困難'], '難度')
                                ]),
                                el('div', { class: 'flex justify-between items-center pt-4 border-t' }, [
                                    el('h3', { class: 'font-bold', textContent: '試煉題目' }),
                                    el('button', { id: 'regenerate-all-questions-btn', class: 'btn-secondary py-2 px-4 text-sm', textContent: '全部重新命題' })
                                ]),
                                el('div', { id: 'edit-questions-container', class: 'space-y-4' }, (container) => { container.innerHTML = questionElementsHtml; })
                            ])
                        ]),
                        el('div', { class: 'mt-6 flex flex-col items-end gap-2' }, [
                            el('p', { id: 'edit-article-error', class: 'text-red-500 text-sm h-4' }),
                            el('div', { class: 'flex gap-4' }, [
                                el('button', { id: 'close-edit-modal-btn', class: 'btn-secondary py-2 px-5 font-bold', textContent: '返回' }),
                                el('button', { id: 'save-edit-btn', 'data-assignment-id': assignment.id, class: 'btn-primary py-2 px-5 font-bold', textContent: '儲存修訂' })
                            ])
                        ])
                    ]);

                    setTimeout(() => {
                        document.getElementById('edit-tag-format').value = tags.format || '純文';
                        document.getElementById('edit-tag-contentType').value = tags.contentType || '記敘';
                        document.getElementById('edit-tag-difficulty').value = tags.difficulty || '普通';
                    }, 0);
                    
                    const base = this._base('', 50); // Create base structure with a placeholder
                    const baseElement = document.createElement('div');
                    baseElement.innerHTML = base;
                    baseElement.querySelector('.modal-backdrop').appendChild(modalContent);
                    resolve(baseElement.innerHTML);
                    setTimeout(() => {
                        const checkbox = document.getElementById('edit-is-public');
                        if (checkbox) {
                            checkbox.checked = !!assignment.isPublic;
                        }
                    }, 0);
                });
            },

            aiAnalysisRefine(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-lg"><h2 class="text-xl font-bold mb-4 text-center font-rounded">AI 潤飾指令</h2><p class="text-sm text-gray-600 mb-4">請輸入您的潤飾要求，例如：「請讓語氣更活潑」、「增加一個關於家庭的比喻」。</p><textarea id="ai-analysis-refine-prompt" class="w-full form-element-ink mb-4" rows="3" placeholder="請輸入指令..."></textarea><div class="flex justify-end gap-4"><button id="cancel-ai-analysis-refine-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-ai-analysis-refine-btn" class="btn-primary py-2 px-5 font-bold">開始潤飾</button></div></div>`;
                    resolve(this._base(content, 60));
                });
            },

            aiRewrite(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-lg"><h2 class="text-xl font-bold mb-4 text-center font-rounded">AI 書僮</h2><p class="text-sm text-gray-600 mb-4">請輸入潤飾指令，例如：「請將此文潤飾得更為典雅」、「將此文縮減至三百字」。AI 將會改寫**編輯區中的文章內容**。</p><textarea id="ai-rewrite-command" class="w-full form-element-ink mb-4" rows="3" placeholder="請輸入指令..."></textarea><div class="flex justify-end gap-4"><button id="close-ai-rewrite-modal-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-ai-rewrite-btn" class="btn-primary py-2 px-5 font-bold">開始潤飾</button></div></div>`;
                    resolve(this._base(content, 60));
                });
            },

            articleAnalysis(data) {
                return new Promise(resolve => {
                    const content = `<div class="card max-w-4xl w-full"><h2 class="text-2xl font-bold mb-6 text-gray-800 font-rounded">${data.title}</h2><div id="article-analysis-content" class="max-h-[70vh] overflow-y-auto custom-scrollbar pr-4">${data.contentHtml}</div><div class="mt-6 flex justify-end items-center gap-4"><button id="analyze-with-ai-btn" data-assignment-id="${data.assignmentId}" class="btn-teal py-2 px-4">AI 點評全學堂表現</button><button id="close-article-analysis-modal" class="btn-secondary py-2 px-5 font-bold">關閉</button></div></div>`;
                    resolve(this._base(content));
                });
            },

            studentAnalysis(data) {
                return new Promise(resolve => {
                    const content = `<div class="card max-w-2xl w-full"><h2 id="student-analysis-title" class="text-2xl font-bold mb-6 text-gray-800 font-rounded">個人課業</h2><div id="student-analysis-content" class="max-h-[70vh] overflow-y-auto custom-scrollbar pr-4"></div><button id="close-student-analysis-modal" class="mt-6 w-full btn-secondary py-2 font-bold">關閉</button></div>`;
                    resolve(this._base(content));
                });
            },

            studentDetail(data) {
                return new Promise(resolve => {
                    const content = `<div class="card max-w-2xl w-full"><h2 id="student-detail-title" class="text-2xl font-bold mb-4 text-gray-800 font-rounded">作答詳情</h2><div id="student-detail-content" class="max-h-[70vh] overflow-y-auto custom-scrollbar pr-4 bg-gray-50 p-4 rounded-lg"></div><button id="close-student-detail-modal" class="mt-6 w-full btn-secondary py-2 font-bold">關閉</button></div>`;
                    resolve(this._base(content));
                });
            },

            deleteClassConfirm(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4 text-red-600">確認解散學堂</h2><p class="text-gray-600 mb-4">這將會永久解散「<strong id="delete-class-name-confirm">${data.className}</strong>」及其所有學子的學習記錄。此舉無法復原。</p><label class="font-bold text-sm">請輸入學堂名稱以確認：</label><input type="text" id="delete-class-confirm-input" class="w-full form-element-ink mt-1 mb-4"><p id="delete-class-confirm-error" class="text-red-500 text-sm h-4 mb-2"></p><div class="flex justify-end gap-4"><button id="cancel-delete-class-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-delete-class-btn" data-class-id="${data.classId}" class="btn-danger py-2 px-5 font-bold">確認解散</button></div></div>`;
                    resolve(this._base(content));
                });
            },

            editClassName(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4">修訂學堂名號</h2><input type="text" id="edit-class-name-input" class="w-full form-element-ink mb-4" value="${escapeHtml(data.className)}"><p id="edit-class-name-error" class="text-red-500 text-sm h-4 mb-2"></p><div class="flex justify-end gap-4"><button id="cancel-edit-class-name-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-edit-class-name-btn" data-class-id="${data.classId}" class="btn-primary py-2 px-5 font-bold">存檔</button></div></div>`;
                    resolve(this._base(content));
                });
            },
            
            changePassword(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4">修改憑信</h2><div class="space-y-4"><div><label class="font-bold text-sm">舊密語</label><input type="password" id="current-password" class="w-full form-element-ink mt-1"></div><div><label class="font-bold text-sm">新密語</label><input type="password" id="new-password" class="w-full form-element-ink mt-1"></div><div><label class="font-bold text-sm">確認新密語</label><input type="password" id="confirm-new-password" class="w-full form-element-ink mt-1"></div></div><p id="change-password-error" class="text-red-500 text-sm h-4 mt-4"></p><div class="flex justify-end gap-4 mt-6"><button id="cancel-change-password-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-change-password-btn" class="btn-primary py-2 px-5 font-bold">確認修訂</button></div></div>`;
                    resolve(this._base(content));
                });
            },

            aiStudentSuggestion(data) {
                return new Promise(resolve => {
                    const content = `<div class="card max-w-2xl w-full"><h2 class="text-2xl font-bold mb-4 text-teal-700 flex items-center gap-2 font-rounded">AI 個人化策勵</h2><div id="ai-student-suggestion-content" class="prose-custom max-h-[70vh] overflow-y-auto text-left p-4 bg-gray-50 rounded-lg">${markdownToHtml(data.suggestionText)}</div><button id="close-ai-suggestion-modal" class="mt-6 w-full btn-primary py-2 font-bold">展卷</button></div>`;
                    resolve(this._base(content));
                });
            },
            
            editStudent(data) {
                return new Promise(resolve => {
                    const student = data.student;
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4">修訂學籍</h2><div class="space-y-4"><div><label class="font-bold text-sm">座號</label><input type="number" id="edit-student-seat" class="w-full form-element-ink mt-1" value="${student.seatNumber}"></div><div><label class="font-bold text-sm">姓名</label><input type="text" id="edit-student-name" class="w-full form-element-ink mt-1" value="${escapeHtml(student.name)}"></div></div><p id="edit-student-error" class="text-red-500 text-sm h-4 mt-4"></p><div class="flex justify-end gap-4 mt-6"><button id="cancel-edit-student-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-edit-student-btn" class="btn-primary py-2 px-5 font-bold">存檔</button></div></div>`;
                    resolve(this._base(content));
                });
            },
            
            deleteStudentConfirm(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4 text-red-600">確認除籍</h2><p class="text-gray-600 mb-4">您確定要將「<strong>${escapeHtml(data.studentName)}</strong>」除籍嗎？此舉將一併移除該位學子的所有課業記錄，且無法復原。</p><div class="flex justify-end gap-4"><button id="cancel-delete-student-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-delete-student-btn" data-class-id="${data.classId}" data-student-id="${data.studentId}" class="btn-danger py-2 px-5 font-bold">確認除籍</button></div></div>`;
                    resolve(this._base(content));
                });
            },
            
            message(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-2">${data.title}</h2><p class="text-slate-600 mb-4">${data.message}</p><button id="close-message-modal-btn" class="w-full btn-primary py-2 font-bold">關閉</button></div>`;
                    resolve(this._base(content));
                });
            },
            
            prompt(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4">${data.title}</h2><p class="text-slate-600 mb-4">${data.message}</p><input type="text" id="prompt-input" class="w-full form-element-ink mt-1 mb-4"><p id="prompt-error" class="text-red-500 text-sm h-4 mb-2"></p><div class="flex justify-end gap-4"><button id="cancel-prompt-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-prompt-btn" class="btn-danger py-2 px-5 font-bold">確認</button></div></div>`;
                    resolve(this._base(content));
                });
            },

            confirm(data) {
                return new Promise(resolve => {
                    const content = `<div class="card w-full max-w-md"><h2 class="text-xl font-bold mb-4">${data.title}</h2><p class="text-slate-600 mb-6">${data.message}</p><div class="flex justify-end gap-4"><button id="cancel-confirm-btn" class="btn-secondary py-2 px-5 font-bold">返回</button><button id="confirm-confirm-btn" class="btn-danger py-2 px-5 font-bold">確認</button></div></div>`;
                    resolve(this._base(content));
                });
            },

            achievementUnlocked(data) {
                return new Promise(resolve => {
                    const { icon, title, description, count } = data;
                    const titleSuffix = count && count > 1 ? ` <span class="text-lg text-amber-600 font-bold">x ${count}</span>` : '';
                    const mainTitle = count && count > 1 ? "成就升級！" : "成就解鎖！";

                    const content = `<div class="card w-full max-w-sm text-center p-8"><h2 class="text-2xl font-bold mb-2 text-amber-500 font-rounded">${mainTitle}</h2><div class="text-6xl my-4">${icon}</div><h3 class="text-xl font-semibold">${title}${titleSuffix}</h3><p class="text-gray-500 mt-1">${description}</p><button id="close-achievement-modal-btn" class="mt-6 w-full btn-primary py-2 font-bold">太棒了！</button></div>`;
                    resolve(this._base(content, 70)); // Higher z-index to appear on top
                });
            },

            achievementsList(data) {
                return new Promise(resolve => {
                    const achievementItems = data.allAchievements.map(ach => {
                        const unlockedRecord = data.unlockedAchievements.find(unlocked => unlocked.achievementId === ach.id);
                        const isUnlocked = !!unlockedRecord;
                        
                        const titleEl = el('h3', { class: 'font-bold text-lg', textContent: ach.title });
                        if (isUnlocked && unlockedRecord.count > 1) {
                            titleEl.appendChild(el('span', {
                                class: 'ml-2 text-amber-600 font-bold text-base',
                                textContent: `x ${unlockedRecord.count}`
                            }));
                        }

                        return el('div', { class: `p-4 border rounded-lg flex items-center gap-4 transition-all ${isUnlocked ? 'bg-amber-50' : 'bg-gray-100 filter grayscale opacity-60'}` }, [
                            el('div', { class: 'text-5xl', textContent: ach.icon }),
                            el('div', {}, [
                                titleEl,
                                el('p', { class: 'text-sm text-gray-600', textContent: ach.description })
                            ])
                        ]);
                    });

                    const content = el('div', { class: 'card max-w-2xl w-full' }, [
                        el('h2', { class: 'text-2xl font-bold mb-6 text-gray-800 font-rounded', textContent: '我的成就' }),
                        el('div', { class: 'max-h-[70vh] overflow-y-auto space-y-3 pr-2' }, achievementItems),
                        el('button', { id: 'close-achievements-list-modal', class: 'mt-6 w-full btn-secondary py-2 font-bold', textContent: '關閉' })
                    ]);
                    
                    const base = this._base('', 50);
                    const baseElement = document.createElement('div');
                    baseElement.innerHTML = base;
                    baseElement.querySelector('.modal-backdrop').appendChild(content);
                    resolve(baseElement.innerHTML);
                });
            },
        };

        modalHtmlGenerators.achievementForm = function(data) {
            return new Promise(resolve => {
                const isEditing = data && data.achievement;
                const ach = isEditing ? data.achievement : {};
                const title = isEditing ? '編輯成就' : '新增成就';

                const formContent = el('div', { class: 'card max-w-2xl w-full' }, [
                    el('h2', { class: 'text-2xl font-bold mb-6 text-gray-800 font-rounded', textContent: title }),
                    el('div', { class: 'space-y-4' }, [
                        el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-4' }, [
                            el('div', {}, [
                                el('label', { class: 'font-bold text-sm', textContent: '成就名稱' }),
                                el('input', { type: 'text', id: 'ach-name', class: 'w-full form-element-ink mt-1', value: ach.name || '' })
                            ]),
                            el('div', {}, [
                                el('label', { class: 'font-bold text-sm', textContent: '圖示 (HTML)' }),
                                el('input', { type: 'text', id: 'ach-icon', class: 'w-full form-element-ink mt-1', value: ach.icon || '' })
                            ])
                        ]),
                        el('div', {}, [
                            el('label', { class: 'font-bold text-sm', textContent: '描述' }),
                            el('textarea', { id: 'ach-description', class: 'w-full form-element-ink mt-1', rows: '3', textContent: ach.description || '' })
                        ]),
                        el('div', { class: 'w-full' }, [
                            el('label', { class: 'font-bold text-sm mb-2 block', textContent: '成就條件 (所有條件需同時滿足)' }),
                            el('div', { id: 'conditions-container', class: 'space-y-3' }),
                            el('button', {
                                id: 'add-condition-btn',
                                type: 'button',
                                class: 'btn-secondary-outline text-sm py-1 px-3 mt-3',
                                textContent: '+ 新增條件'
                            })
                        ]),
                        el('div', { class: 'flex items-center space-x-8 pt-2' }, [
                            el('label', { class: 'flex items-center gap-2 cursor-pointer' }, [
                                el('input', { type: 'checkbox', id: 'ach-isEnabled', class: 'h-4 w-4 rounded' }),
                                el('span', { class: 'font-bold text-sm', textContent: '啟用此成就' })
                            ]),
                            el('label', { class: 'flex items-center gap-2 cursor-pointer' }, [
                                el('input', { type: 'checkbox', id: 'ach-isHidden', class: 'h-4 w-4 rounded' }),
                                el('span', { class: 'font-bold text-sm', textContent: '設為隱藏成就' })
                            ]),
                            el('label', { class: 'flex items-center gap-2 cursor-pointer' }, [
                                el('input', { type: 'checkbox', id: 'ach-isRepeatable', class: 'h-4 w-4 rounded' }),
                                el('span', { class: 'font-bold text-sm', textContent: '可重複獲得' })
                            ])
                        ])
                    ]),
                    el('p', { id: 'ach-form-error', class: 'text-red-500 text-sm h-4 mt-4' }),
                    el('div', { class: 'flex justify-between items-center mt-6' }, [
                        el('button', { id: 'ai-generate-achievement-btn', class: 'btn-teal py-2 px-5 font-bold', textContent: 'AI 發想' }),
                        el('div', { class: 'flex gap-4' }, [
                           el('button', { id: 'cancel-ach-form-btn', class: 'btn-secondary py-2 px-5 font-bold', textContent: '返回' }),
                           el('button', { id: 'save-ach-form-btn', 'data-id': isEditing ? ach.id : '', class: 'btn-primary py-2 px-5 font-bold', textContent: '儲存' })
                        ])
                    ])
                ]);

                // --- Logic for the new dynamic condition form ---

                const conditionOptions = [
                    { label: '基本成就', options: [
                        { value: 'submission_count', text: '總閱讀篇數' },
                        { value: 'login_streak', text: '連續登入天數' },
                        { value: 'high_score_streak', text: '連續高分次數' },
                        { value: 'completion_streak', text: '課業完成率100%連續天數' },
                    ]},
                    { label: '學習表現', options: [
                        { value: 'average_score', text: '平均分數達標' },
                        { value: 'genre_explorer', text: '文體全通 (完成 N 種文體)' },
                        { value: 'weekly_progress', text: '本週進步 (與上週比)' },
                    ]},
                    { label: '閱讀廣度 (內容)', options:
                        ['記敘', '抒情', '說明', '議論', '應用'].map(tag => ({ value: `read_tag_contentType_${tag}`, text: `完成「${tag}」文章數` }))
                    },
                    { label: '閱讀廣度 (難度)', options:
                        ['基礎', '普通', '進階', '困難'].map(tag => ({ value: `read_tag_difficulty_${tag}`, text: `完成「${tag}」文章數` }))
                    }
                ];
                // Expose conditionOptions for AI function
                modalHtmlGenerators.achievementForm.conditionOptions = conditionOptions;

                function renderConditionBlock(condition = {}) {
                    const container = document.getElementById('conditions-container');
                    const conditionDiv = el('div', { class: 'condition-block flex items-center gap-2 p-2 border rounded-md bg-gray-50' }, [
                        el('div', { class: 'flex-grow' }, [
                            el('select', { class: 'ach-condition-type w-full form-element-ink' },
                                [el('option', { value: '', textContent: '---選取條件類型---' })].concat(
                                    conditionOptions.map(group =>
                                        el('optgroup', { label: group.label },
                                            group.options.map(opt => el('option', { value: opt.value, textContent: opt.text }))
                                        )
                                    )
                                )
                            )
                        ]),
                        el('div', { class: 'flex-grow' }, [
                            el('input', { type: 'number', class: 'ach-condition-value w-full form-element-ink', placeholder: '條件值' })
                        ]),
                        el('button', { type: 'button', class: 'remove-condition-btn btn-danger-outline text-xl font-bold w-8 h-8 flex items-center justify-center', textContent: '×' })
                    ]);

                    // Set values if editing
                    if (condition.type) {
                        conditionDiv.querySelector('.ach-condition-type').value = condition.type;
                    }
                    if (condition.value) {
                        conditionDiv.querySelector('.ach-condition-value').value = condition.value;
                    }
                    
                    container.appendChild(conditionDiv);

                    // After appending, check and set initial visibility
                    const typeSelect = conditionDiv.querySelector('.ach-condition-type');
                    const valueInput = conditionDiv.querySelector('.ach-condition-value');
                    const typesWithoutValue = ['weekly_progress'];
                    valueInput.style.display = typesWithoutValue.includes(typeSelect.value) ? 'none' : '';
                }

                // Initial state & Event listeners
                setTimeout(() => {
                    if (isEditing) {
                        if (ach.conditions && Array.isArray(ach.conditions)) {
                            ach.conditions.forEach(cond => renderConditionBlock(cond));
                        } else if (ach.type) { // Backward compatibility for old format
                            renderConditionBlock({ type: ach.type, value: ach.value });
                        }
                        document.getElementById('ach-isEnabled').checked = ach.isEnabled;
                        document.getElementById('ach-isHidden').checked = ach.isHidden;
                        document.getElementById('ach-isRepeatable').checked = ach.isRepeatable;
                    } else {
                        renderConditionBlock(); // Start with one empty block
                        document.getElementById('ach-isEnabled').checked = true;
                    }

                    // Attach event listeners now that the modal is in the DOM
                    document.getElementById('add-condition-btn').addEventListener('click', () => renderConditionBlock());
                    document.getElementById('conditions-container').addEventListener('click', function(e) {
                        if (e.target && e.target.classList.contains('remove-condition-btn')) {
                            e.target.closest('.condition-block').remove();
                        }
                    });

                    document.getElementById('conditions-container').addEventListener('change', function(e) {
                        if (e.target && e.target.classList.contains('ach-condition-type')) {
                            const conditionBlock = e.target.closest('.condition-block');
                            const valueInput = conditionBlock.querySelector('.ach-condition-value');
                            const typesWithoutValue = ['weekly_progress'];
                            
                            if (typesWithoutValue.includes(e.target.value)) {
                                valueInput.style.display = 'none';
                                valueInput.value = ''; // Clear value when hidden
                            } else {
                                valueInput.style.display = '';
                            }
                        }
                    });
                }, 0);

                const base = this._base('', 60); // Higher z-index
                const baseElement = document.createElement('div');
                baseElement.innerHTML = base;
                baseElement.querySelector('.modal-backdrop').appendChild(formContent);
                resolve(baseElement.innerHTML);
            });
        }

      function el(tag, attributes = {}, children = []) {
          const element = document.createElement(tag);
          for (const key in attributes) {
              if (key === 'textContent') {
                  element.textContent = attributes[key];
              } else if (key === 'innerHTML') {
                  element.innerHTML = attributes[key];
              } else if (key.startsWith('on') && typeof attributes[key] === 'function') {
                  element.addEventListener(key.substring(2).toLowerCase(), attributes[key]);
              }
              else {
                  element.setAttribute(key, attributes[key]);
              }
          }
          if (typeof children === 'function') {
              children(element);
          } else if (Array.isArray(children)) {
              for (const child of children) {
                  if (child === null || child === undefined) continue;
                  if (typeof child === 'string') {
                      element.appendChild(document.createTextNode(child));
                  } else if (child instanceof HTMLElement) {
                      element.appendChild(child);
                  }
              }
          } else if (typeof children === 'string') {
              element.appendChild(document.createTextNode(children));
          } else if (children instanceof HTMLElement) {
              element.appendChild(children);
          }
          return element;
      }

      function updateElement(parent, newNode, oldNode) {
          if (!oldNode) {
              parent.appendChild(newNode);
          } else if (!newNode) {
              parent.removeChild(oldNode);
          } else if (newNode.nodeType === Node.TEXT_NODE && oldNode.nodeType === Node.TEXT_NODE) {
              if (newNode.textContent !== oldNode.textContent) {
                  oldNode.textContent = newNode.textContent;
              }
          } else if (newNode.tagName !== oldNode.tagName) {
              parent.replaceChild(newNode, oldNode);
          } else {
              // Update attributes
              const oldAttrs = oldNode.attributes;
              const newAttrs = newNode.attributes;
              
              for (let i = oldAttrs.length - 1; i >= 0; i--) {
                  const { name } = oldAttrs[i];
                  if (!newNode.hasAttribute(name)) {
                      oldNode.removeAttribute(name);
                  }
              }

              for (let i = 0; i < newAttrs.length; i++) {
                  const { name, value } = newAttrs[i];
                  if (oldNode.getAttribute(name) !== value) {
                      oldNode.setAttribute(name, value);
                  }
              }

              // Update children
              const newChildren = Array.from(newNode.childNodes);
              const oldChildren = Array.from(oldNode.childNodes);
              const maxLength = Math.max(newChildren.length, oldChildren.length);

              for (let i = 0; i < maxLength; i++) {
                  updateElement(oldNode, newChildren[i], oldChildren[i]);
              }
          }
      }

        function renderModal(type, data = {}) {
            return new Promise(async (resolve, reject) => {
                const generator = modalHtmlGenerators[type];
                if (!generator) {
                    console.error(`Modal type "${type}" not found.`);
                    return reject(new Error(`Modal type "${type}" not found.`));
                }

                try {
                    showLoading('載入中...');
                    const modalHtml = await generator.call(modalHtmlGenerators, data);
                    
                    if (!modalHtml) {
                        hideLoading();
                        return resolve(null);
                    }
                    
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = modalHtml;
                    const modalElement = tempDiv.firstElementChild;
                    dom.modalContainer.appendChild(modalElement);

                    // Handle prompt-like modals that need to return a value
                    if (type === 'aiAnalysisRefine') {
                        const confirmBtn = modalElement.querySelector('#confirm-ai-analysis-refine-btn');
                        const cancelBtn = modalElement.querySelector('#cancel-ai-analysis-refine-btn');
                        const input = modalElement.querySelector('#ai-analysis-refine-prompt');

                        const close = (value) => {
                            modalElement.remove();
                            resolve(value); // Resolve the promise with the input value or null
                        };

                        confirmBtn.onclick = () => close(input.value);
                        cancelBtn.onclick = () => close(null);
                        
                    } else {
                        // For other modals, attach standard listeners and resolve without a specific value
                        attachModalEventListeners(type, data);
                        resolve();
                    }
                } catch (error) {
                    console.error(`Error rendering modal "${type}":`, error);
                    renderModal('message', { title: '錯誤', message: '無法載入視窗內容。' });
                    reject(error);
                } finally {
                    hideLoading();
                }
            });
        }

        function attachModalEventListeners(type, data = {}) {
            const modalInstance = dom.modalContainer.lastElementChild;
            if (!modalInstance) return;
        
            const clickHandler = (e) => {
                const target = e.target;
                const targetId = target.id;
                const targetClassList = target.classList;
        
                // General close actions for all modals
                if (target === modalInstance || targetId?.includes('close-') || targetId?.includes('cancel-')) {
                    if (targetId === 'close-result-modal') {
                        dom.modalContainer.innerHTML = ''; // Clear all modals
                        if (appState.currentAssignment) {
                            displayAssignment(appState.currentAssignment);
                        } else {
                            showArticleGrid();
                        }
                    } else {
                        closeModal(); // Close only the top modal
                    }
                    return;
                }
        
                // Specific button actions within the modal
                switch (targetId) {
                    case 'password-submit-btn': handleTeacherLogin(e); break;
                    case 'view-analysis-btn':
                        const assignment = data.assignment; // Assuming assignment data is passed to the result modal
                        if (assignment) {
                            displayAnalysis(assignment);
                        } else {
                            console.error("No assignment data available for analysis.");
                        }
                        break;
                    case 'save-edit-btn': handleSaveEdit(e); break;
                    case 'edit-ai-assistant-btn':
                        const articleText = document.getElementById('edit-article').value;
                        renderModal('aiRewrite', { articleText });
                        break;
                    case 'confirm-ai-rewrite-btn': handleAiRewrite(); break;
                    case 'regenerate-all-questions-btn':
                        handleRegenerateQuestions(target.closest('.card').querySelector('#save-edit-btn').dataset.assignmentId);
                        break;
                    case 'confirm-delete-class-btn': confirmDeleteClass(target.dataset.classId); break;
                    case 'confirm-edit-class-name-btn': handleConfirmEditClassName(target.dataset.classId); break;
                    case 'confirm-change-password-btn': handleChangePassword(); break;
                    case 'confirm-delete-student-btn': confirmDeleteStudent(); break;
                    case 'confirm-edit-student-btn': handleSaveStudentEdit(); break;
                    case 'analyze-with-ai-btn': handleAiAnalysis(target.dataset.assignmentId); break;
                    case 'save-ach-form-btn': handleSaveAchievement(target.dataset.id); break;
                    case 'ai-generate-achievement-btn': handleAiGenerateAchievement(); break;
                    case 'confirm-prompt-btn':
                        if (data.onConfirm) {
                            const input = document.getElementById('prompt-input');
                            if (input) data.onConfirm(input.value.trim());
                        }
                        break;
                    case 'confirm-confirm-btn':
                        closeModal();
                        if(data.onConfirm) data.onConfirm();
                        break;
                }
        
                if (targetClassList.contains('regenerate-question-btn')) {
                    const questionIndex = parseInt(target.dataset.questionIndex, 10);
                    const assignmentId = target.closest('.card').querySelector('#save-edit-btn').dataset.assignmentId;
                    handleRegenerateQuestions(assignmentId, questionIndex);
                }
                if(targetClassList.contains('view-submission-review-btn')) {
                    const { assignmentId, studentId } = target.dataset;
                    displaySubmissionReview(assignmentId, studentId);
                }
            };
        
            // Add a single, unique event listener to the modal instance
            modalInstance.addEventListener('click', clickHandler);
        }

        function showLoading(message) {
            const overlay = document.getElementById('loading-overlay');
            const messageEl = document.getElementById('loading-message');
            if (overlay && messageEl) {
                messageEl.textContent = message;
                overlay.classList.remove('hidden');
            }
        }

        function hideLoading() {
            const overlay = document.getElementById('loading-overlay');
            if (overlay) {
                overlay.classList.add('hidden');
            }
        }
        const escapeHtml = (unsafe) => unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        
        function normalizeClassName(className) {
            if (!className) return "";
            const numMap = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9' };
            const digitsOnly = className.replace(/[一二三四五六七八九]/g, match => numMap[match]).replace(/\D/g, '');
            return digitsOnly;
        }

        function generateDefaultPassword(className, seatNumber) {
            const normalizedClass = normalizeClassName(className);
            const formattedSeat = String(seatNumber).padStart(2, '0');
            return `${normalizedClass}${formattedSeat}`;
        }

        function markdownToHtml(text) {
            // Ensure input is a string to prevent .replace errors
            if (typeof text !== 'string' || !text) {
                return '';
            }

            // Regex to find mermaid blocks, allowing for nested content and empty lines.
            const mermaidRegex = /```mermaid([\s\S]*?)```/g;
            const placeholders = [];
            let placeholderId = 0;

            // 1. Replace all mermaid blocks with placeholders
            const textWithPlaceholders = text.replace(mermaidRegex, (match, mermaidContent) => {
                const placeholder = `__MERMAID_PLACEHOLDER_${placeholderId++}__`;
                // The 'white-space: pre' style is crucial to preserve the line breaks for the Mermaid parser.
                // Removed .trim() to avoid altering mermaid syntax indentation.
                placeholders.push(`<div class="mermaid" style="white-space: pre;">${mermaidContent}</div>`);
                return placeholder;
            });

            // 2. Process the rest of the text as before
            const blocks = textWithPlaceholders.split(/(\n\s*\n)/); // Split by one or more empty lines
            let html = '';
            let paragraphCounter = 1;

            blocks.forEach(block => {
                if (block.trim() === '') return;

                // Check if the block is a placeholder
                if (block.trim().startsWith('__MERMAID_PLACEHOLDER_')) {
                    const id = parseInt(block.trim().replace('__MERMAID_PLACEHOLDER_', '').replace('__', ''));
                    html += placeholders[id];
                    return;
                }

                const hasIndent = block.startsWith('　　');
                let trimmedBlock = block.trim();

                // Table processing
                if (trimmedBlock.startsWith('|') && trimmedBlock.includes('|')) {
                    let tableHtml = '';
                    const lines = trimmedBlock.split('\n');
                     if (lines.length > 1 && lines[1].match(/\| *(:?-+:?|---) *\|/)) {
                        const headers = lines[0].split('|').map(h => h.trim()).slice(1, -1);
                        const rows = lines.slice(2);
                        tableHtml = '<div class="my-6 overflow-x-auto"><table class="min-w-full border border-slate-300 divide-y divide-slate-200"><thead class="bg-slate-50">';
                        tableHtml += `<tr>${headers.map(h => `<th class="px-4 py-2 text-left text-sm font-medium text-slate-600">${h.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</th>`).join('')}</tr></thead>`;
                        tableHtml += '<tbody class="bg-white divide-y divide-slate-200">';
                        rows.forEach(rowLine => {
                            if (rowLine.trim() === '') return;
                            const cells = rowLine.split('|').map(c => c.trim()).slice(1, -1);
                            tableHtml += `<tr>${cells.map(c => `<td class="px-4 py-2 text-sm text-slate-700">${c.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</td>`).join('')}</tr>`;
                        });
                        tableHtml += '</tbody></table></div>';
                        html += tableHtml;
                        return;
                    }
                }
                
                // Heading processing
                if (trimmedBlock.startsWith('#### ')) { html += `<h4 class="text-lg font-bold mb-3 mt-5">${trimmedBlock.substring(5).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</h4>`; return; }
                if (trimmedBlock.startsWith('### ')) { html += `<h3 class="text-xl font-bold mb-4 mt-6">${trimmedBlock.substring(4).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</h3>`; return; }
                if (trimmedBlock.startsWith('## ')) { html += `<h2 class="text-2xl font-bold mb-4 mt-8 border-b pb-2">${trimmedBlock.substring(3).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</h2>`; return; }
                if (trimmedBlock.startsWith('# ')) { html += `<h1 class="text-3xl font-bold mb-6 mt-8">${trimmedBlock.substring(2).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')}</h1>`; return; }

                // List processing
                if (trimmedBlock.startsWith('* ') || trimmedBlock.startsWith('- ')) {
                    html += '<ul class="list-disc list-inside my-4 space-y-2">';
                    trimmedBlock.split('\n').forEach(item => {
                         let listItemContent = item.substring(item.indexOf(' ') + 1);
                         listItemContent = listItemContent
                            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-red-700 hover:underline">$1</a>');
                         html += `<li>${listItemContent}</li>`;
                    });
                    html += '</ul>';
                    return;
                }

                // Paragraph processing
                let processedContent = trimmedBlock
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" class="text-red-700 hover:underline">$1</a>')
                    .replace(/\n/g, '<br>');

                if (hasIndent) {
                    html += `<div style="position: relative; margin-bottom: 1rem;">` +
                            `<p class="prose-custom" style="margin: 0; text-indent: 2em;">${processedContent}</p>` +
                            `<span class="text-gray-400 text-xs select-none" style="position: absolute; left: 0; top: 0.7em;">${paragraphCounter++}</span>` +
                            `</div>`;
                } else {
                    html += `<p class="prose-custom">${processedContent}</p>`;
                }
            });

            return html;
        }
        
        function formatSubmissionTime(timestamp) {
            if (!timestamp || !timestamp.toDate) return '';
            const date = timestamp.toDate();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            return `(${month}/${day} ${hours}:${minutes})`;
        }

        function formatTime(seconds) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
        }

        function startQuizTimer() {
            stopQuizTimer(); // Ensure no multiple timers running
            appState.quizTimer.startTime = Date.now();
            appState.quizTimer.elapsedSeconds = 0;
            const timerElement = document.getElementById('quiz-timer-display');
            if (timerElement) {
                timerElement.textContent = formatTime(0);
            }

            appState.quizTimer.intervalId = setInterval(() => {
                const now = Date.now();
                appState.quizTimer.elapsedSeconds = Math.floor((now - appState.quizTimer.startTime) / 1000);
                if (timerElement) {
                    timerElement.textContent = formatTime(appState.quizTimer.elapsedSeconds);
                }
            }, 1000);
        }

        function stopQuizTimer(preserveDisplay = false) {
            if (appState.quizTimer.intervalId) {
                clearInterval(appState.quizTimer.intervalId);
                appState.quizTimer.intervalId = null;
            }
            if (!preserveDisplay) {
                appState.quizTimer.elapsedSeconds = 0;
                const timerDisplay = document.getElementById('quiz-timer-display');
                if (timerDisplay) timerDisplay.textContent = '00:00';
            }
        }

        async function hashString(str) {
            const encoder = new TextEncoder();
            const data = encoder.encode(str);
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        }

        async function initializeAppCore() {
            setupEventListeners();
            setupTeacherEventListeners();
            try {
               // First, fetch the API Key from Firestore
               const settingsDoc = await getDoc(doc(db, "settings", "api_keys"));
               if (settingsDoc.exists()) {
                   const settings = settingsDoc.data();
                   appState.geminiApiKey = settings.gemini || null;
                   appState.geminiModel = settings.model || 'gemini-1.5-flash'; // Default model
               } else {
                   console.error("Gemini API Key not found in Firestore under settings/api_keys");
                   // We don't show a fatal error here, but AI features will fail.
                   // The error will be caught when an AI function is called.
               }

                if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
                    await signInWithCustomToken(auth, __initial_auth_token);
                } else {
                    await signInAnonymously(auth);
                }

                // 檢查儲存的登入狀態
                const savedUser = localStorage.getItem(`currentUser_${appId}`);
                if (savedUser) {
                    appState.currentUser = JSON.parse(savedUser);
                    await loadStudentSubmissions(appState.currentUser.studentId);
                    if (appState.currentUser.type === 'student') {
                        document.getElementById('teacher-view-btn').classList.add('hidden');
                        document.getElementById('view-tabs').classList.add('hidden');
                        switchViewTab('student');
                    } else if (appState.currentUser.type === 'teacher') {
                        document.getElementById('teacher-view-btn').classList.remove('hidden');
                        document.getElementById('view-tabs').classList.remove('hidden');
                        switchViewTab('student'); // 預設顯示學生視角，老師可自行切換
                    }
                    showView('app');
                    requestAnimationFrame(updateHeader); // Update header after view is shown
                } else {
                    showView('login');
                }

                // The logic for ensuring teacher settings/user exists is now handled
                // by the login and password change functions. This block is obsolete.
                loadAllData();
            } catch (error) {
                console.error("Authentication or Initialization failed:", error);
                showView('error', { title: '書院開啟失敗', message: '書院初始化或憑證驗證失敗，請刷新頁面或聯繫夫子。' });
            } finally {
                dom.appLoader.classList.add('hidden');
            }
        }

        function loadAllData() {
            const commonErrorHandler = (name) => (error) => console.error(`讀取${name}有誤:`, error);

            onSnapshot(query(collection(db, "classes")), snapshot => {
                let wasSelectedClassRemoved = false;
                const selectedClassId = document.getElementById('class-selector')?.value;

                snapshot.docChanges().forEach(change => {
                    const doc = change.doc;
                    const classData = { id: doc.id, ...doc.data() };
                    const index = appState.allClasses.findIndex(c => c.id === doc.id);

                    if (change.type === "added") {
                        if (index === -1) appState.allClasses.push(classData);
                    }
                    if (change.type === "modified") {
                        if (index > -1) appState.allClasses[index] = classData;
                    }
                    if (change.type === "removed") {
                        if (index > -1) appState.allClasses.splice(index, 1);
                        if (doc.id === selectedClassId) {
                            wasSelectedClassRemoved = true;
                        }
                    }
                });

                appState.allClasses.sort((a, b) => a.className.localeCompare(b.className, 'zh-Hant'));
                
                populateClassSelectors();

                if (wasSelectedClassRemoved) {
                    // If the active class was deleted, re-render the management panel to its empty state.
                    renderClassManagement(null);
                }

            }, commonErrorHandler('班級'));

            

        }

        async function loadStudentSubmissions(studentId) {
            if (!studentId) return []; // Return empty array if no ID
            const submissionsQuery = query(
                collection(db, "submissions"),
                where('studentId', '==', studentId)
            );
            try {
                const snapshot = await getDocs(submissionsQuery);
                const submissions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                appState.allSubmissions = submissions; // Still update global state for other parts of the app
                return submissions; // Return the submissions array
            } catch (error) {
                console.error("Error fetching student submissions:", error);
                appState.allSubmissions = [];
                return []; // Return empty array on error
            }
        }

        async function loadSubmissionsByClass(classId) {
            if (!classId) return [];
            const submissionsQuery = query(
                collection(db, "submissions"),
                where('classId', '==', classId)
            );
            try {
                const snapshot = await getDocs(submissionsQuery);
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            } catch (error) {
                console.error("Error fetching submissions by class:", error);
                return [];
            }
        }

        async function loadSubmissionsByAssignment(assignmentId) {
            if (!assignmentId) return [];
            const submissionsQuery = query(
                collection(db, "submissions"),
                where('assignmentId', '==', assignmentId)
            );
            try {
                const snapshot = await getDocs(submissionsQuery);
                return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            } catch (error) {
                console.error("Error fetching submissions by assignment:", error);
                return [];
            }
        }

        function updateHeader() {
            const avatarDiv = document.getElementById('user-avatar');
            const avatarTextSpan = document.getElementById('user-avatar-text');
            const userGreeting = document.getElementById('user-greeting');
            const userClass = document.getElementById('user-class');
            const viewTabsContainer = document.getElementById('view-tabs-container');

            if (!appState.currentUser || !appState.currentUser.name) {
                userGreeting.textContent = '歡迎！';
                userClass.textContent = '訪客';
                avatarDiv.classList.remove('avatar-seal');
                avatarDiv.classList.add('bg-gray-200');
                avatarTextSpan.textContent = '?';
                avatarTextSpan.className = 'text-xl font-bold text-gray-600';
                if(viewTabsContainer) viewTabsContainer.classList.add('hidden');
                return;
            }

            const lastChar = appState.currentUser.name.slice(-1);
            
            avatarDiv.classList.remove('bg-gray-200');
            avatarDiv.classList.add('avatar-seal');
            avatarTextSpan.className = 'avatar-seal-text';
            avatarTextSpan.textContent = lastChar;

            if (appState.currentUser.type === 'student') {
                userGreeting.textContent = `學子 ${appState.currentUser.name}`;
                userClass.textContent = appState.currentUser.className || '尚未分班';
            } else if (appState.currentUser.type === 'teacher') {
                userGreeting.textContent = `夫子 ${appState.currentUser.name}`;
                userClass.textContent = '指導中';
            }

            if (viewTabsContainer) {
                viewTabsContainer.classList.toggle('hidden', appState.currentUser.type !== 'teacher');
            }
        }

        function renderAllViews() {
            // This function is now deprecated and replaced by more granular rendering.
            // Kept empty to avoid breaking any potential old references, will be removed later.
        }
        
        async function showArticleGrid() {
            // Clear existing articles and reset state for a fresh view
            const container = document.getElementById('assignment-grid-container');
            if (container) {
                container.innerHTML = ''; // Clear previous content
            }
            // Fetch the first page of articles
            await fetchAssignmentsPage(true);
            document.getElementById('student-sidebar').classList.remove('hidden');
            const readingView = document.getElementById('reading-view');
            readingView.classList.remove('lg:col-span-3', 'reading-mode');
            readingView.classList.add('lg:col-span-2');
            readingView.style.padding = ''; // Let the .card style restore padding

            document.getElementById('article-grid-view')?.classList.remove('hidden');
            document.getElementById('analysis-display')?.classList.add('hidden'); // Hide analysis view
            const contentView = document.getElementById('content-display');
            if (contentView) {
                contentView.classList.add('hidden');
                contentView.innerHTML = '';
            }
            appState.currentAssignment = null;
        }

        function showArticleContent() {
            document.getElementById('student-sidebar').classList.add('hidden');
            const readingView = document.getElementById('reading-view');
            readingView.classList.remove('lg:col-span-2');
            readingView.classList.add('lg:col-span-3', 'reading-mode');

            document.getElementById('article-grid-view')?.classList.add('hidden');
            document.getElementById('content-display')?.classList.remove('hidden');
        }

        function renderStudentUI() {
            renderCalendar();
            // renderAssignmentsList and renderArticleGrid are now called by fetchAssignmentsPage
        }

        function renderTeacherUI(selectedClassId = null, selectedArticleId = null) {
            const teacherContent = document.getElementById('teacher-main-content');
            if (!teacherContent) return;
            
            if (!teacherContent.querySelector('#tab-panel-class-overview')) {
                teacherContent.innerHTML = ''; // Clear once
                const fragment = document.createDocumentFragment();
                
                fragment.appendChild(
                    el('div', { class: 'card mb-6' }, [
                        el('div', { class: 'flex justify-between items-center' }, [
                            el('h3', { class: 'text-xl font-bold font-rounded', textContent: '掌理學堂' }),
                            el('div', { class: 'flex gap-2 items-center' }, [
                                el('select', { id: 'class-selector', class: 'input-styled' }),
                                el('button', { id: 'add-class-btn', class: 'btn-primary py-2 px-4 text-sm', textContent: '新設學堂' }),
                                el('button', { id: 'edit-class-name-btn', class: 'btn-secondary py-2 px-4 text-sm', disabled: true, textContent: '修訂名號' }),
                                el('button', { id: 'delete-class-btn', class: 'btn-danger py-2 px-4 text-sm', disabled: true, textContent: '解散學堂' })
                            ])
                        ])
                    ])
                );

                fragment.appendChild(
                    el('div', { id: 'tab-panel-class-overview', class: 'teacher-tab-panel' }, [
                        el('div', { id: 'class-management-content', class: 'mt-4' })
                    ])
                );

                fragment.appendChild(
                    el('div', { id: 'tab-panel-article-library', class: 'teacher-tab-panel hidden' }, [
                        el('div', { id: 'article-library-content' })
                    ])
                );

                fragment.appendChild(
                    el('div', { id: 'tab-panel-achievement-management', class: 'teacher-tab-panel hidden' }, [
                        el('div', { id: 'achievement-management-content' })
                    ])
                );
                
                teacherContent.appendChild(fragment);
            }

            populateClassSelectors();

            const classSelector = document.getElementById('class-selector');
            if (classSelector && selectedClassId) {
                classSelector.value = selectedClassId;
            }

            const currentTab = document.querySelector('.teacher-tab-btn.active')?.dataset.tab || 'class-overview';
            switchTeacherTab(currentTab, selectedClassId, selectedArticleId);
        }

        function switchViewTab(view) {
            appState.currentView = view; // Update current view state
            const container = document.getElementById('app-content-container');
            if (!container) return;

            container.innerHTML = ''; // Clear previous view

            const templateId = view === 'student' ? 'template-student-view' : 'template-teacher-view';
            const template = document.getElementById(templateId);

            if (template) {
                const content = template.content.cloneNode(true);
                container.appendChild(content);
            }

            document.getElementById('student-view-btn').classList.toggle('active', view === 'student');
            document.getElementById('teacher-view-btn').classList.toggle('active', view === 'teacher');

            if (view === 'teacher') {
                appState.currentAssignment = null;
                renderTeacherUI();
            } else {
                // Re-render necessary components for student view
                fetchAssignmentsPage(true);
                renderCalendar();
                // renderAssignmentsList is now called by fetchAssignmentsPage
            }
        }

        function populateClassSelectors() {
            const selectors = [
                document.getElementById('class-login-selector'),
                document.getElementById('class-selector')
            ];

            selectors.forEach(selector => {
                if (selector) {
                    const currentVal = selector.value;
                    selector.innerHTML = ''; // Clear existing options

                    const placeholderText = selector.id === 'class-login-selector' ? '請選擇學堂...' : '選擇一個學堂...';
                    selector.appendChild(el('option', { value: '', textContent: placeholderText }));

                    appState.allClasses.forEach(cls => {
                        selector.appendChild(el('option', { value: cls.id, textContent: cls.className }));
                    });
                    
                    if (appState.allClasses.some(c => c.id === currentVal)) {
                        selector.value = currentVal;
                    }
                }
            });
        }

        async function populateStudentLoginSelector(classId) {
            const studentSelector = document.getElementById('student-login-selector');
            const passwordInput = document.getElementById('student-password-input');
            const loginBtn = document.getElementById('student-login-btn');
            
            studentSelector.innerHTML = ''; // Clear
            studentSelector.appendChild(el('option', { value: '', textContent: '--- 請選擇學子 ---' }));
            
            studentSelector.disabled = true;
            passwordInput.disabled = true;
            loginBtn.disabled = true;

            if (!classId) return;

            try {
                const studentsQuery = query(collection(db, `classes/${classId}/students`), orderBy('seatNumber'));
                const studentsSnapshot = await getDocs(studentsQuery);

                if (!studentsSnapshot.empty) {
                    const fragment = document.createDocumentFragment();
                    studentsSnapshot.forEach(doc => {
                        const student = doc.data();
                        fragment.appendChild(
                            el('option', {
                                value: doc.id, // Use studentId as the value
                                textContent: `${student.seatNumber}號 ${student.name}`
                            })
                        );
                    });
                    studentSelector.appendChild(fragment);
                    studentSelector.disabled = false;
                    passwordInput.disabled = false;
                }
            } catch (error) {
                console.error("Error populating student selector:", error);
            }
        }
        
        async function renderClassManagement(classId) {
            const contentDiv = document.getElementById('class-management-content');
            if (!contentDiv) return;
            if (classId) {
                contentDiv.dataset.classId = classId;
            } else {
                delete contentDiv.dataset.classId;
            }

            // Load submissions for the selected class on demand
            appState.classSubmissions = classId ? await loadSubmissionsByClass(classId) : [];

            const editBtn = document.getElementById('edit-class-name-btn');
            const deleteBtn = document.getElementById('delete-class-btn');
            
            contentDiv.innerHTML = ''; // Clear existing content

            if (!classId) {
                contentDiv.appendChild(
                    el('div', { class: 'text-center text-slate-500 p-8 rounded-lg bg-slate-50', textContent: '請先從上方擇一學堂進行掌理，或新設學堂。' })
                );
                if(editBtn) editBtn.disabled = true;
                if(deleteBtn) deleteBtn.disabled = true;
                return;
            }
            
            if(editBtn) { editBtn.disabled = false; editBtn.dataset.classId = classId; }
            if(deleteBtn) { deleteBtn.disabled = false; deleteBtn.dataset.classId = classId; }

            const fragment = document.createDocumentFragment();

            fragment.appendChild(
                el('div', { class: 'p-4 border-t' }, [
                    el('h4', { class: 'font-semibold mb-2 text-slate-600', textContent: '學子名錄' }),
                    el('div', { id: 'roster-display', class: 'p-4 border rounded-lg bg-gray-50 min-h-[100px] max-h-[300px] overflow-y-auto custom-scrollbar' })
                ])
            );

            fragment.appendChild(
                el('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-6 border-t pt-6 mt-6' }, [
                    el('div', {}, [
                        el('h4', { class: 'font-semibold mb-2 text-slate-600', textContent: '單增學子' }),
                        el('div', { class: 'flex gap-2' }, [
                            el('input', { type: 'number', id: 'new-student-seat', class: 'w-1/4 input-styled', placeholder: '座號' }),
                            el('input', { type: 'text', id: 'new-student-name', class: 'w-3/4 input-styled', placeholder: '學子姓名' }),
                            el('button', { id: 'add-student-btn', 'data-class-id': classId, class: 'btn-primary py-2 px-5 font-bold', textContent: '登錄' })
                        ])
                    ]),
                    el('div', {}, [
                        el('h4', { class: 'font-semibold mb-2 text-slate-600', textContent: '批量延攬' }),
                        el('textarea', { id: 'bulk-import-textarea', rows: '5', class: 'w-full input-styled', placeholder: '格式：座號,姓名 (一行一位)' }),
                        el('button', { id: 'bulk-import-btn', 'data-class-id': classId, class: 'w-full mt-2 btn-secondary py-2 px-5 font-bold', textContent: '延攬' })
                    ])
                ])
            );

            fragment.appendChild(
                el('div', { class: 'border-t pt-6 mt-6' }, [
                    el('div', { class: 'flex justify-between items-center mb-2' }, [
                        el('h4', { class: 'font-semibold text-slate-600', textContent: '逾期課業回報' }),
                        el('button', { id: 'generate-overdue-report-btn', 'data-class-id': classId, class: 'btn-secondary py-1 px-3 text-xs', textContent: '生成回報' })
                    ]),
                    el('div', { id: 'overdue-report-container', class: 'p-4 border rounded-lg bg-red-50 min-h-[100px]' })
                ])
            );
            
            contentDiv.appendChild(fragment);
            updateRosterDisplay(classId);
            const reportContainer = document.getElementById('overdue-report-container');
            if(reportContainer) {
                reportContainer.innerHTML = `<p class="text-slate-400 text-center">點擊「生成回報」以查看最新數據。</p>`;
            }
        }

        async function updateArticleLibraryPanel(classId, selectedArticleId = null) {
            const panel = document.getElementById('tab-panel-article-library');
            if (!panel) return;
            
            // Only clear if the panel is not already populated
            if (!panel.querySelector('#article-library-main')) {
                panel.innerHTML = '';
            }

            const createTagSelect = (id, label, options) => el('div', {}, [
                el('label', { class: 'text-sm font-medium text-slate-600', textContent: `${label} (選填)` }),
                el('select', { id, class: 'w-full input-styled mt-1 text-sm' }, [
                    el('option', { value: '', textContent: 'AI 自動判斷' }),
                    ...options.map(opt => el('option', { value: opt, textContent: `#${opt}` }))
                ])
            ]);

            const createFilterSelect = (id, label, options) => el('select', { id, class: 'teacher-select-filter input-styled text-sm' }, [
                el('option', { value: '', textContent: label }),
                ...Object.entries(options).map(([value, text]) => el('option', { value, textContent: text }))
            ]);

            const aiGeneratePanel = el('div', { id: 'panel-ai-generate', class: 'space-y-4' }, [
                el('h3', { class: 'text-lg font-semibold', textContent: '依題生成篇章與試煉' }),
                el('div', { class: 'space-y-3' }, [
                    el('input', { type: 'text', id: 'topic-input', class: 'w-full input-styled', placeholder: '請輸入篇章主題' }),
                    el('div', { class: 'grid grid-cols-1 md:grid-cols-3 gap-4' }, [
                        createTagSelect('tag-format-input', '形式', ['純文', '圖表', '圖文']),
                        createTagSelect('tag-contentType-input', '內容', ['記敘', '抒情', '說明', '議論', '應用']),
                        createTagSelect('tag-difficulty-input', '難度', ['簡單', '基礎', '普通', '進階', '困難'])
                    ]),
                    el('div', {}, [
                        el('label', { class: 'text-sm font-medium text-slate-600', textContent: '挑戰期限 (選填)' }),
                        el('input', { type: 'date', id: 'deadline-input', class: 'w-full input-styled mt-1' })
                    ]),
                    el('div', { class: 'form-check items-center flex gap-2 my-3' }, [
                        el('input', { class: 'form-check-input w-5 h-5', type: 'checkbox', id: 'ai-is-public', checked: true }),
                        el('label', { class: 'form-check-label font-bold', htmlFor: 'ai-is-public', textContent: '將此篇章設為公開' })
                    ]),
                    el('button', { id: 'generate-btn', class: 'w-full btn-primary py-3 text-base font-bold', textContent: '生成' })
                ])
            ]);

            const pasteTextPanel = el('div', { id: 'panel-paste-text', class: 'hidden space-y-4' }, [
                el('h3', { class: 'text-lg font-semibold', textContent: '為文章生成試煉' }),
                el('div', { class: 'space-y-3' }, [
                    el('input', { type: 'text', id: 'pasted-title-input', class: 'w-full input-styled', placeholder: '請輸入篇章標題' }),
                    el('textarea', { id: 'pasted-article-textarea', rows: '10', class: 'w-full input-styled', placeholder: '請在此貼上你的篇章內容...' }),
                    el('div', { class: 'grid grid-cols-1 md:grid-cols-3 gap-4' }, [
                        createTagSelect('pasted-tag-format-input', '形式', ['純文', '圖表', '圖文']),
                        createTagSelect('pasted-tag-contentType-input', '內容', ['記敘', '抒情', '說明', '議論', '應用']),
                        createTagSelect('pasted-tag-difficulty-input', '難度', ['簡單', '基礎', '普通', '進階', '困難'])
                    ]),
                     el('div', {}, [
                        el('label', { class: 'text-sm font-medium text-slate-600', textContent: '挑戰期限 (選填)' }),
                        el('input', { type: 'date', id: 'pasted-deadline-input', class: 'w-full input-styled mt-1' })
                    ]),
                    el('div', { class: 'form-check items-center flex gap-2 my-3' }, [
                        el('input', { class: 'form-check-input w-5 h-5', type: 'checkbox', id: 'pasted-is-public', checked: true }),
                        el('label', { class: 'form-check-label font-bold', htmlFor: 'pasted-is-public', textContent: '將此篇章設為公開' })
                    ]),
                    el('div', { class: 'flex gap-4 mt-2' }, [
                        el('button', { id: 'format-text-btn', class: 'w-1/3 btn-secondary py-3 text-base font-bold', textContent: '整理文本' }),
                        el('button', { id: 'generate-questions-btn', class: 'w-2/3 btn-primary py-3 text-base font-bold', textContent: '生成試題' })
                    ])
                ])
            ]);

            const createArticlePanel = el('div', { id: 'panel-create-article', class: 'hidden' }, [
                el('div', { class: 'flex border-b-2 border-gray-200 mb-4' }, [
                    el('button', { id: 'tab-ai-generate', class: 'creation-tab font-bold py-2 px-4 text-sm rounded-t-lg active', textContent: 'AI 起草' }),
                    el('button', { id: 'tab-paste-text', class: 'creation-tab font-bold py-2 px-4 text-sm rounded-t-lg', textContent: '貼入文章' })
                ]),
                aiGeneratePanel,
                pasteTextPanel
            ]);

            const analyzeArticlePanel = el('div', { id: 'panel-analyze-article', class: 'card' }, [
                el('div', { class: 'mb-4 flex flex-wrap gap-4 items-center' }, [
                    el('input', { type: 'text', id: 'article-search-input', class: 'input-styled w-full md:w-auto flex-grow', placeholder: '🔍 搜尋篇章名號...' }),
                    createFilterSelect('filter-tag-format', '所有形式', { '純文': '#純文', '圖表': '#圖表', '圖文': '#圖文' }),
                    createFilterSelect('filter-tag-contentType', '所有內容', { '記敘': '#記敘', '抒情': '#抒情', '說明': '#說明', '議論': '#議論', '應用': '#應用' }),
                    createFilterSelect('filter-tag-difficulty', '所有難度', { '簡單': '#簡單', '基礎': '#基礎', '普通': '#普通', '進階': '#進階', '困難': '#困難' }),
                    createFilterSelect('filter-deadline-status', '所有期限', { 'active': '進行中', 'expired': '已逾期', 'none': '無期限' })
                ]),
                el('div', { id: 'bulk-actions-container', class: 'hidden mb-4 flex items-center gap-2' }, [
                    el('span', { class: 'text-sm font-medium text-slate-600', textContent: '對選取項目進行：'}),
                    el('button', { id: 'bulk-set-public-btn', class: 'btn-teal py-2 px-4 text-sm', textContent: '設為公開' }),
                    el('button', { id: 'bulk-set-private-btn', class: 'btn-secondary py-2 px-4 text-sm', textContent: '設為私密' }),
                    el('div', { class: 'h-4 border-l border-slate-300 mx-2' }), // Divider
                    el('button', { id: 'bulk-delete-btn', class: 'btn-danger py-2 px-4 text-sm', textContent: '刪除' })
                ]),
                el('div', { class: 'overflow-x-auto rounded-lg border border-slate-200' }, [
                    el('table', { class: 'min-w-full divide-y divide-slate-200' }, [
                        el('thead', { class: 'bg-slate-50' }, [
                            el('tr', {}, [
                                el('th', { scope: 'col', class: 'relative px-6 py-4 text-left' }, [ el('input', { type: 'checkbox', id: 'select-all-articles', class: 'w-[0.875rem] h-[0.875rem] rounded border-gray-300 text-indigo-600 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50' }) ]),
                                el('th', { scope: 'col', class: 'px-6 py-4 text-left font-semibold text-slate-500', textContent: '名號' }),
                                el('th', { scope: 'col', class: 'px-6 py-4 text-left font-semibold text-slate-500', textContent: '形式' }),
                                el('th', { scope: 'col', class: 'px-6 py-4 text-left font-semibold text-slate-500', textContent: '內容' }),
                                el('th', { scope: 'col', class: 'px-6 py-4 text-left font-semibold text-slate-500', textContent: '難度' }),
                                el('th', { scope: 'col', class: 'relative px-6 py-4' }, [ el('span', { class: 'sr-only', textContent: '行事' }) ])
                            ])
                        ]),
                        el('tbody', { id: 'article-list-body', class: 'bg-white divide-y divide-slate-200' })
                    ])
                ]),
                el('div', { id: 'teacher-load-more-container', class: 'mt-4 flex justify-center hidden' }, [
                    el('button', { id: 'load-more-teacher-articles-btn', class: 'btn-secondary py-2 px-6' }, ['載入更多'])
                ]),
                el('div', { id: 'analysis-panel', class: 'hidden mt-8 card' }, [
                    el('h3', { id: 'analysis-title', class: 'text-xl font-bold text-gray-800 mb-4 font-rounded' }),
                    el('button', {
                        id: 'ai-analysis-btn',
                        class: 'w-full btn-teal py-3 px-4 font-bold mb-6 flex items-center justify-center gap-2',
                        textContent: '啟動 AI 分析全隊表現',
                        onclick: async (e) => {
                            const articleId = e.currentTarget.dataset.articleId;
                            if (!articleId) return;
                            showLoading('正在分析全隊表現...');
                            const submissions = await loadSubmissionsByAssignment(articleId);
                            const selectedClass = appState.allClasses.find(c => c.id === appState.currentUser.selectedClassId);
                            const roster = selectedClass?.roster || [];
                            const resultsContainer = document.getElementById('results-table-container');
                            renderResultsTable(resultsContainer, submissions, roster);
                            hideLoading();
                        }
                    }),
                    el('div', { id: 'results-table-container', class: 'overflow-x-auto' })
                ])
            ]);

            const mainCard = el('div', { class: 'card mb-8' }, [
                el('div', { class: 'flex border-b-2 border-gray-200 mb-4' }, [
                    el('button', { id: 'tab-create-article', class: 'creation-tab font-bold py-2 px-6 rounded-t-lg', textContent: '新撰篇章' }),
                    el('button', { id: 'tab-analyze-article', class: 'creation-tab font-bold py-2 px-6 rounded-t-lg active', textContent: '篇章書庫' })
                ]),
                createArticlePanel,
                analyzeArticlePanel
            ]);

            panel.appendChild(mainCard);
            fetchTeacherAssignmentsPage(true); // Initial fetch
        }

        function updateTeacherLoadMoreButton() {
            const loadMoreContainer = document.getElementById('teacher-load-more-container');
            if (!loadMoreContainer) return;
            
            const state = appState.teacherArticleQueryState;
            const loadMoreBtn = loadMoreContainer.querySelector('#load-more-teacher-articles-btn');

            if (state.isLastPage) {
                loadMoreContainer.classList.add('hidden');
            } else {
                loadMoreContainer.classList.remove('hidden');
                if (loadMoreBtn) {
                    loadMoreBtn.disabled = state.isLoading;
                    loadMoreBtn.textContent = state.isLoading ? '載入中...' : '載入更多';
                }
            }
        }

        function renderTeacherArticleTable(assignments, isNewQuery) {
            const tableBody = document.getElementById('article-list-body');
            if (!tableBody) return;

            if (isNewQuery) {
                tableBody.innerHTML = '';
            }

            if (assignments.length === 0 && isNewQuery) {
                tableBody.innerHTML = `<tr><td colspan="7" class="text-center p-8 text-slate-500">沒有找到符合條件的篇章。</td></tr>`;
            } else if (assignments.length > 0) {
                const fragment = document.createDocumentFragment();
                assignments.forEach(assignment => {
                    fragment.appendChild(createFullArticleTableRow(assignment));
                });
                tableBody.appendChild(fragment);
            }
        }

        function createFullArticleCard(assignment) {
            const userSubmissions = (appState.currentUser?.studentId) ? appState.allSubmissions.filter(s => s.studentId === appState.currentUser.studentId) : [];
            const submission = userSubmissions.find(s => s.assignmentId === assignment.id);
            const isCompleted = !!submission;

            let statusDiv;
            if (isCompleted) {
                statusDiv = el('div', { class: 'status-seal status-seal-complete', title: `已完成`, textContent: '完成' });
            } else if (assignment.deadline && new Date() > assignment.deadline.toDate()) {
                statusDiv = el('div', { class: 'status-seal status-seal-overdue', title: '已過期', textContent: '逾期' });
            } else {
                statusDiv = el('div', { class: 'status-seal status-seal-incomplete', title: '未完成', textContent: '未完' });
            }

            let deadlineDiv = null;
            if (assignment.deadline) {
                const d = assignment.deadline.toDate();
                deadlineDiv = el('div', {
                    class: 'absolute top-4 right-5 text-xs font-semibold inline-flex items-center px-2 py-0.5 rounded-full bg-red-100 text-red-800 z-10',
                    textContent: `期限: ${d.getMonth() + 1}/${d.getDate()}`
                });
            }

            const tags = assignment.tags || {};
            const tagChildren = [];
            if (tags.format) tagChildren.push(el('span', { class: 'bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full font-medium', textContent: `#${tags.format}` }));
            if (tags.contentType) tagChildren.push(el('span', { class: 'bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full font-medium', textContent: `#${tags.contentType}` }));
            if (tags.difficulty) tagChildren.push(el('span', { class: 'bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium', textContent: `#${tags.difficulty}` }));
            
            const card = el('div', {
                'data-assignment-id': assignment.id,
                class: 'assignment-card-item relative flex flex-col justify-between bg-white border-2 border-slate-200 rounded-lg shadow-sm hover:shadow-xl hover:border-red-700 transition-all duration-300 cursor-pointer animate-fade-in' // Added fade-in animation
            }, [
                statusDiv,
                el('div', { class: 'p-5 pt-10 flex flex-col flex-grow' }, [
                    deadlineDiv,
                    el('h3', { class: 'text-lg font-bold text-slate-800 mb-2 flex-grow', textContent: assignment.title }),
                    el('p', { class: 'text-sm text-slate-500 mb-4', textContent: `${assignment.article.replace(/(\r\n|\n|\r|　)/gm, " ").trim().substring(0, 20)}...` }),
                    el('div', { class: 'mt-auto' }, [ el('div', { class: 'flex flex-wrap gap-2 text-xs' }, tagChildren) ])
                ]),
                el('div', { class: 'p-4 bg-slate-50 border-t-2 border-slate-100 rounded-b-lg' }, [
                    el('button', { class: 'w-full btn-primary py-2 px-4 text-sm', textContent: isCompleted ? '查看結果' : '開始試煉' })
                ])
            ]);
            return card;
        }

        function createFullArticleTableRow(assignment) {
            const tags = assignment.tags || {};
            let deadlineText = '';
            if (assignment.deadline && typeof assignment.deadline.toDate === 'function') {
                const d = assignment.deadline.toDate();
                deadlineText = ` <span class="text-slate-500 font-normal">(${d.getMonth() + 1}/${d.getDate()})</span>`;
            }

            const isPublicBadge = `<span class="ml-2 text-xs font-bold px-2 py-1 rounded-full ${assignment.isPublic ? 'bg-teal-100 text-teal-700' : 'bg-slate-200 text-slate-600'}">${assignment.isPublic ? '公開' : '私密'}</span>`;

            const row = el('tr', { 'data-assignment-id': assignment.id, class: 'animate-fade-in' });
            row.innerHTML = `
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                    <input type="checkbox" class="article-checkbox w-[0.875rem] h-[0.875rem] rounded border-gray-300 text-indigo-600 shadow-sm focus:border-indigo-300 focus:ring focus:ring-indigo-200 focus:ring-opacity-50" value="${assignment.id}">
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                    <a href="#" class="article-title-link font-medium text-slate-900 hover:text-red-700" data-assignment-id="${assignment.id}">${escapeHtml(assignment.title)}</a>${isPublicBadge}${deadlineText}
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                    <span class="px-2 inline-flex leading-5 font-semibold rounded-full bg-orange-100 text-orange-800">
                        ${escapeHtml(tags.format || 'N/A')}
                    </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                    <span class="px-2 inline-flex leading-5 font-semibold rounded-full bg-rose-100 text-rose-800">
                        ${escapeHtml(tags.contentType || 'N/A')}
                    </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm">
                     <span class="px-2 inline-flex leading-5 font-semibold rounded-full bg-amber-100 text-amber-800">
                        ${escapeHtml(tags.difficulty || 'N/A')}
                    </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <button class="edit-article-btn btn-secondary btn-sm" data-assignment-id="${assignment.id}">潤飾</button>
                     <button class="delete-article-btn btn-danger btn-sm ml-2" data-assignment-id="${assignment.id}">刪除</button>
                </td>
            `;
            return row;
        }



        async function updateRosterDisplay(classId) {
            const rosterDisplay = document.getElementById('roster-display');
            if (!rosterDisplay || !classId) return;

            rosterDisplay.innerHTML = '<p class="text-slate-500">讀取中...</p>';

            try {
                const students = await loadStudentsForClass(classId);
                
                rosterDisplay.innerHTML = ''; // Clear loading message

                if (students === null) {
                     rosterDisplay.innerHTML = '<p class="text-red-500">讀取學子名錄失敗。</p>';
                     return;
                }

                if (students.length === 0) {
                    rosterDisplay.appendChild(el('p', { class: 'text-slate-400', textContent: '這個學堂還沒有學子。' }));
                } else {
                    const fragment = document.createDocumentFragment();
                    // Sort students by seat number (as numbers) before rendering
                    students.sort((a, b) => parseInt(a.seatNumber, 10) - parseInt(b.seatNumber, 10));
                    students.forEach(student => {
                        const studentRow = el('div', { class: 'flex items-center justify-between bg-slate-100 rounded-lg px-3 py-2 mr-2 mb-2' }, [
                            el('span', {
                                class: 'student-name-link text-sm font-semibold text-slate-700 cursor-pointer hover:text-red-700 hover:underline',
                                'data-student-id': student.id,
                                textContent: `${student.seatNumber}號 ${student.name}`
                            }),
                            el('div', { class: 'flex items-center gap-2' }, [
                                el('button', { 'data-class-id': classId, 'data-student-id': student.id, class: 'edit-student-btn text-xs font-bold text-gray-600 hover:text-gray-800 bg-gray-200 px-2 py-1 rounded-full', textContent: '修訂學籍' }),
                                el('button', { 'data-class-id': classId, 'data-student-id': student.id, class: 'delete-student-btn text-xs font-bold text-red-600 hover:text-red-800 bg-red-100 px-2 py-1 rounded-full', textContent: '除籍' }),
                                el('button', { 'data-class-id': classId, 'data-student-id': student.id, class: 'reset-password-btn text-xs font-bold text-orange-600 hover:text-orange-800 bg-orange-100 px-2 py-1 rounded-full', textContent: '重置密語' })
                            ])
                        ]);
                        fragment.appendChild(studentRow);
                    });
                    rosterDisplay.appendChild(fragment);
                }
            } catch (error) {
                console.error("Error updating roster display:", error);
                rosterDisplay.innerHTML = '<p class="text-red-500">讀取學子名錄失敗。</p>';
            }
        }

        async function renderOverdueReport(classId) {
            const container = document.getElementById('overdue-report-container');
            if (!container || !classId) return;

            container.innerHTML = `<p class="text-slate-400 text-center">正在生成回報...</p>`;
            showLoading('正在計算逾期回報...');

            try {
                const students = await loadStudentsForClass(classId);
                if (students === null) {
                    container.innerHTML = `<p class="text-red-500 text-center">無法載入學子名冊以生成報告。</p>`;
                    return;
                }
                 if (students.length === 0) {
                    container.innerHTML = `<p class="text-slate-500 text-center">學堂尚無學子，無法生成報告。</p>`;
                    return;
                }

                const now = new Date();
                const overdueAssignmentsQuery = query(
                    collection(db, `assignments`),
                    where('deadline', '<', now)
                );
                const overdueAssignmentsSnapshot = await getDocs(overdueAssignmentsQuery);
                const overdueAssignments = overdueAssignmentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                if (overdueAssignments.length === 0) {
                    container.innerHTML = `<p class="text-slate-500 text-center">太棒了！目前沒有任何已過期的課業。</p>`;
                    return;
                }

                const classSubmissionsQuery = query(
                    collection(db, "submissions"),
                    where('classId', '==', classId)
                );
                const classSubmissionsSnapshot = await getDocs(classSubmissionsQuery);
                const classSubmissions = classSubmissionsSnapshot.docs.map(doc => doc.data());

                const overdueByStudent = {};
                students.forEach(student => {
                    const studentOverdueTasks = [];
                    overdueAssignments.forEach(assignment => {
                        const hasSubmitted = classSubmissions.some(s => s.studentId === student.id && s.assignmentId === assignment.id);
                        if (!hasSubmitted) {
                            const deadline = assignment.deadline.toDate();
                            const deadlineStr = `(${(deadline.getMonth() + 1)}/${deadline.getDate()})`;
                            studentOverdueTasks.push(`${assignment.title} <span class="text-xs text-red-700 font-medium">${deadlineStr}</span>`);
                        }
                    });
                    if (studentOverdueTasks.length > 0) {
                        overdueByStudent[student.id] = {
                            studentInfo: student,
                            tasks: studentOverdueTasks
                        };
                    }
                });

                const sortedOverdueStudents = Object.values(overdueByStudent).sort((a, b) => a.studentInfo.seatNumber - b.studentInfo.seatNumber);
                
                container.innerHTML = ''; // Clear loading message
                if (sortedOverdueStudents.length === 0) {
                    container.appendChild(el('p', { class: 'text-slate-500 text-center', textContent: '太棒了！本學堂無人逾期。' }));
                    return;
                }

                const list = el('ul', { class: 'space-y-3' });
                sortedOverdueStudents.forEach(data => {
                    const student = data.studentInfo;
                    const listItem = el('li', { class: 'text-sm' }, [
                        el('strong', { class: 'font-semibold text-slate-800', textContent: `${student.seatNumber}號 ${student.name}：` }),
                        el('span', { class: 'text-slate-600', innerHTML: data.tasks.join('、 ') })
                    ]);
                    list.appendChild(listItem);
                });
                container.appendChild(list);

            } catch (error) {
                console.error("Error generating overdue report:", error);
                container.innerHTML = `<p class="text-red-500 text-center">生成回報時發生錯誤。</p>`;
            } finally {
                hideLoading();
            }
        }
        
        async function handleStudentLogin() {
            const errorEl = document.getElementById('login-error');
            errorEl.textContent = '';
            const classId = document.getElementById('class-login-selector').value;
            const studentId = document.getElementById('student-login-selector').value;
            const passwordInput = document.getElementById('student-password-input').value;

            if (!classId || !studentId || !passwordInput) {
                errorEl.textContent = '請選擇學堂、姓名並輸入憑信！';
                return;
            }

            try {
                const studentDocRef = doc(db, `classes/${classId}/students`, studentId);
                const studentDoc = await getDoc(studentDocRef);

                if (!studentDoc.exists()) {
                    errorEl.textContent = '查無此學子！';
                    return;
                }

                const studentData = studentDoc.data();
                const selectedClass = appState.allClasses.find(c => c.id === classId);
                const className = selectedClass ? selectedClass.className : '未知班級';

                const defaultPassword = generateDefaultPassword(className, studentData.seatNumber);
                const passwordHashOnRecord = studentData.passwordHash || await hashString(defaultPassword);
                const enteredPasswordHash = await hashString(passwordInput);

                if (enteredPasswordHash !== passwordHashOnRecord) {
                    errorEl.textContent = '憑信有誤！';
                    setTimeout(() => errorEl.textContent = '', 3000);
                    return;
                }

                appState.currentUser = {
                    type: 'student',
                    studentId: studentId,
                    name: studentData.name,
                    seatNumber: studentData.seatNumber,
                    classId: classId,
                    className: className,
                    completionStreak: 0, // Initialize with default
                    ...studentData
                };

                localStorage.setItem(`currentUser_${appId}`, JSON.stringify(appState.currentUser));

                // --- Dynamic Achievement Check Trigger for Login ---
                try {
                    const studentRef = doc(db, `classes/${classId}/students`, studentId);
                    const getLocalDateString = (date) => {
                        const d = new Date(date);
                        const year = d.getFullYear();
                        const month = String(d.getMonth() + 1).padStart(2, '0');
                        const day = String(d.getDate()).padStart(2, '0');
                        return `${year}-${month}-${day}`;
                    };

                    const todayStr = getLocalDateString(new Date());
                    const updates = {};

                    // --- Login Streak Logic ---
                    const lastLogin = studentData.lastLoginDate ? getLocalDateString(studentData.lastLoginDate.toDate()) : null;
                    let newLoginStreak = 1;
                    if (lastLogin) {
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        const yesterdayStr = getLocalDateString(yesterday);
                        if (lastLogin === yesterdayStr) {
                            newLoginStreak = (studentData.loginStreak || 0) + 1;
                        } else if (lastLogin === todayStr) {
                            newLoginStreak = studentData.loginStreak || 1; // Already logged in today, streak doesn't change
                        }
                    }
                    updates.loginStreak = newLoginStreak;
                    updates.lastLoginDate = Timestamp.now();

                    // --- Completion Streak Logic ---
                    const lastCompletionCheck = studentData.lastCompletionCheckDate ? getLocalDateString(studentData.lastCompletionCheckDate.toDate()) : null;
                    let newCompletionStreak = studentData.completionStreak || 0;
                    if (lastCompletionCheck !== todayStr) {
                        const allAssignmentsSnapshot = await getDocs(collection(db, "assignments"));
                        const allAssignments = allAssignmentsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
                        const studentSubmissions = await loadStudentSubmissions(studentId);
                         const studentSubmissionIds = new Set((studentSubmissions || []).map(s => s.assignmentId));
                        
                        const yesterday = new Date();
                        yesterday.setDate(yesterday.getDate() - 1);
                        yesterday.setHours(23, 59, 59, 999); // End of yesterday
                        
                        const dueAssignments = allAssignments.filter(a => a.deadline && a.deadline.toDate() <= yesterday);
                        const allDueAssignmentsCompleted = dueAssignments.every(a => studentSubmissionIds.has(a.id));

                        if (dueAssignments.length > 0 && allDueAssignmentsCompleted) {
                            newCompletionStreak++;
                        } else if (dueAssignments.length > 0 && !allDueAssignmentsCompleted) {
                            newCompletionStreak = 0; // Reset streak if any due assignment is not completed
                        }
                        // If no assignments were due, the streak continues (do nothing to newCompletionStreak)
                        updates.completionStreak = newCompletionStreak;
                        updates.lastCompletionCheckDate = Timestamp.now();
                    }
                    
                    // --- Update Firestore and Local State ---
                    await updateDoc(studentRef, updates);
                    Object.assign(appState.currentUser, updates);
                    
                    console.log('Login Streak Calculated:', updates.loginStreak, 'Completion Streak Calculated:', updates.completionStreak);
                    console.log('appState after update:', appState.currentUser);

                    // --- Check Achievements ---
                    checkAndAwardAchievements(studentId, 'login', appState.currentUser);
                } catch (error) {
                    console.error("Failed to update student login streak or check achievements:", error);
                }
                await loadStudentSubmissions(appState.currentUser.studentId);
                showView('app');
                requestAnimationFrame(updateHeader);
                document.getElementById('teacher-view-btn').classList.add('hidden');

            } catch (error) {
                console.error("Error during student login:", error);
                errorEl.textContent = '登入時發生錯誤，請稍後再試。';
            }
        }

        async function handleTeacherLogin() {
            const passwordInput = document.getElementById('password-input').value.trim();
            const errorEl = document.getElementById('password-error');
            if(errorEl) errorEl.textContent = '';

            try {
                const teacherUserRef = doc(db, "classes/teacher_class/students", "teacher_user");
                const teacherUserSnap = await getDoc(teacherUserRef);

                let passwordHashOnRecord;
                const teacherData = teacherUserSnap.exists() ? teacherUserSnap.data() : {};

                if (teacherUserSnap.exists() && teacherData.passwordHash) {
                    passwordHashOnRecord = teacherData.passwordHash;
                } else {
                    passwordHashOnRecord = TEACHER_PASSWORD_HASH; // Fallback to hardcoded hash
                }

                const enteredPasswordHash = await hashString(passwordInput);

                if (enteredPasswordHash === passwordHashOnRecord) {
                    appState.currentUser = { type: 'teacher', name: '筱仙', studentId: 'teacher_user', classId: 'teacher_class', className: '教師講堂', ...teacherData };
                    localStorage.setItem(`currentUser_${appId}`, JSON.stringify(appState.currentUser));
                    
                    await processUserLogin(teacherData, 'teacher_user', 'teacher_class');

                    await loadStudentSubmissions(appState.currentUser.studentId);
                    appState.currentView = 'teacher';
                    showView('app');
                    requestAnimationFrame(updateHeader);
                    document.getElementById('teacher-view-btn').classList.remove('hidden');
                    document.getElementById('view-tabs').classList.remove('hidden');
                    closeModal();
                } else {
                    if(errorEl) errorEl.textContent = '憑信錯誤。';
                }
            } catch (error) {
                console.error("Teacher login error:", error);
                if(errorEl) errorEl.textContent = '驗證時發生錯誤。';
            }
        }

        async function processUserLogin(userData, userId, classId) {
            try {
                const userRef = doc(db, `classes/${classId}/students`, userId);
                const getLocalDateString = (date) => {
                    const d = new Date(date);
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    return `${year}-${month}-${day}`;
                };
                const todayStr = getLocalDateString(new Date());
                const updates = {};

                // Login Streak Logic
                const lastLogin = userData.lastLoginDate ? getLocalDateString(userData.lastLoginDate.toDate()) : null;
                let newLoginStreak = 1;
                if (lastLogin) {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    const yesterdayStr = getLocalDateString(yesterday);
                    if (lastLogin === yesterdayStr) {
                        newLoginStreak = (userData.loginStreak || 0) + 1;
                    } else if (lastLogin === todayStr) {
                        newLoginStreak = userData.loginStreak || 1;
                    }
                }
                updates.loginStreak = newLoginStreak;
                updates.lastLoginDate = Timestamp.now();

                // Completion Streak Logic
                const lastCompletionCheck = userData.lastCompletionCheckDate ? getLocalDateString(userData.lastCompletionCheckDate.toDate()) : null;
                let newCompletionStreak = userData.completionStreak || 0;
                if (lastCompletionCheck !== todayStr) {
                    const yesterday = new Date();
                    yesterday.setDate(yesterday.getDate() - 1);
                    yesterday.setHours(23, 59, 59, 999);

                    const assignmentsQuery = query(
                        collection(db, "assignments"),
                        where("deadline", "<=", Timestamp.fromDate(yesterday))
                    );
                    const dueAssignmentsSnapshot = await getDocs(assignmentsQuery);
                    const dueAssignments = dueAssignmentsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));

                    const userSubmissions = await loadStudentSubmissions(userId);
                    const userSubmissionIds = new Set((userSubmissions || []).map(s => s.assignmentId));
                    const allDueAssignmentsCompleted = dueAssignments.every(a => userSubmissionIds.has(a.id));

                    if (dueAssignments.length > 0 && allDueAssignmentsCompleted) {
                        newCompletionStreak++;
                    } else if (dueAssignments.length > 0 && !allDueAssignmentsCompleted) {
                        newCompletionStreak = 0;
                    }
                    updates.completionStreak = newCompletionStreak;
                    updates.lastCompletionCheckDate = Timestamp.now();
                }
                
                await updateDoc(userRef, updates);
                Object.assign(appState.currentUser, updates);
                
                console.log(`User ${userId} - Login Streak: ${updates.loginStreak}, Completion Streak: ${updates.completionStreak}`);

                checkAndAwardAchievements(userId, 'login', appState.currentUser);

            } catch (error) {
                console.error(`Failed to process login for user ${userId}:`, error);
            }
        }

        async function handleLogout() {
            try {
                await signOut(auth);
                localStorage.removeItem(`currentUser_${appId}`);
                location.reload();
            } catch (error) {
                console.error("Logout failed:", error);
                // Even if signout fails, force a refresh to a clean state
                location.reload();
            }
        }

        
        function handleDeleteClass(classId) {
            if (!classId) { renderModal('message', { type: 'error', title: '操作錯誤', message: '請先選擇要解散的學堂。' }); return; }
            const selectedClass = appState.allClasses.find(c => c.id === classId);
            if (!selectedClass) { renderModal('message', { type: 'error', title: '操作錯誤', message: '找不到班級資料，請重新整理。' }); return; }
            renderModal('deleteClassConfirm', { classId, className: selectedClass.className });
        }

        async function confirmDeleteClass(classId) {
            const selectedClass = appState.allClasses.find(c => c.id === classId);
            const inputName = document.getElementById('delete-class-confirm-input').value;
            const errorEl = document.getElementById('delete-class-confirm-error');

            if (inputName !== selectedClass.className) {
                errorEl.textContent = '學堂名號輸入有誤。';
                return;
            }

            closeModal();
            showLoading('正在解散學堂...');
            try {
                const batch = writeBatch(db);
                batch.delete(doc(db, "classes", classId));
                
                const submissionsQuery = query(collection(db, "submissions"), where("classId", "==", classId));
                const submissionsSnapshot = await getDocs(submissionsQuery);
                submissionsSnapshot.forEach(d => batch.delete(d.ref));

                await batch.commit();
                renderModal('message', { type: 'success', title: '操作成功', message: `學堂「${selectedClass.className}」已成功解散。` });
            } catch (e) {
                console.error("刪除班級失敗:", e);
                renderModal('message', { type: 'error', title: '解散失敗', message: '操作失敗，請檢查主控台錯誤訊息。' });
            } finally {
                hideLoading();
            }
        }

        async function handleAddStudent(classId) {
            const seatNumberInput = document.getElementById('new-student-seat');
            const nameInput = document.getElementById('new-student-name');
            const seatNumber = seatNumberInput.value.trim();
            const name = nameInput.value.trim();
            if (!classId || !seatNumber || !name) { renderModal('message', { type: 'error', title: '登錄失敗', message: '請填寫所有欄位！' }); return; }
            
            const studentsRef = collection(db, `classes/${classId}/students`);
            const seatQuery = query(studentsRef, where("seatNumber", "==", parseInt(seatNumber)), limit(1));
            const seatSnapshot = await getDocs(seatQuery);
            if (!seatSnapshot.empty) { renderModal('message', { type: 'error', title: '登錄失敗', message: '該座號已存在。' }); return; }

            const selectedClass = appState.allClasses.find(c => c.id === classId);
            const defaultPassword = generateDefaultPassword(selectedClass.className, seatNumber);
            const studentId = `${classId}_${seatNumber}`;
            const newStudent = { name, seatNumber: parseInt(seatNumber), studentId, passwordHash: await hashString(defaultPassword) };
            
            try {
                await setDoc(doc(studentsRef, studentId), newStudent);
                seatNumberInput.value = ''; nameInput.value = '';
                renderModal('message', { type: 'success', title: '登錄成功', message: `學子「${name}」已成功登錄！` });
                updateRosterDisplay(classId); // Refresh roster
            } catch(e) { console.error("新增學生失敗:", e); renderModal('message', { type: 'error', title: '登錄失敗', message: '操作失敗，請稍後再試。' }); }
        }
        
        async function handleBulkImport(classId) {
            const importText = document.getElementById('bulk-import-textarea').value.trim();
            if (!classId || !importText) { renderModal('message', { type: 'error', title: '延攬失敗', message: '請選擇學堂並貼上名錄。' }); return; }
            
            const selectedClass = appState.allClasses.find(c => c.id === classId);
            const studentsRef = collection(db, `classes/${classId}/students`);
            const existingStudentsSnap = await getDocs(studentsRef);
            const existingSeats = new Set(existingStudentsSnap.docs.map(d => d.data().seatNumber));

            const lines = importText.split('\n').filter(line => line.trim() !== '');
            const batch = writeBatch(db);
            let newStudentCount = 0;

            for (const [i, line] of lines.entries()) {
                const parts = line.split(/[,，]/);
                if (parts.length !== 2) { renderModal('message', { type: 'error', title: '格式錯誤', message: `格式錯誤於第 ${i+1} 行: "${line}"` }); return; }
                const [seatStr, name] = parts.map(p => p.trim());
                const seatNumber = parseInt(seatStr);
                if (isNaN(seatNumber) || !name) { renderModal('message', { type: 'error', title: '格式錯誤', message: `格式錯誤於第 ${i+1} 行: "${line}"` }); return; }
                if (existingSeats.has(seatNumber)) { continue; /* Skip existing student */ }
                
                const defaultPassword = generateDefaultPassword(selectedClass.className, seatNumber);
                const studentId = `${classId}_${seatNumber}`;
                const newStudent = { name, seatNumber, studentId, passwordHash: await hashString(defaultPassword) };
                
                batch.set(doc(studentsRef, studentId), newStudent);
                existingSeats.add(seatNumber);
                newStudentCount++;
            }

            if (newStudentCount === 0) { renderModal('message', { type: 'info', title: '提示', message: '沒有可延攬的新學子（可能座號都已存在）。' }); return; }
            
            try {
                await batch.commit();
                renderModal('message', { type: 'success', title: '延攬成功', message: `成功延攬 ${newStudentCount} 位新學子！` });
                updateRosterDisplay(classId); // Refresh roster
            } catch (e) { console.error("批量匯入失敗:", e); renderModal('message', { type: 'error', title: '延攬失敗', message: '操作失敗，請稍後再試。' }); }
        }

        async function handleEditStudent(classId, studentId) {
            try {
                const studentDocRef = doc(db, `classes/${classId}/students`, studentId);
                const studentDoc = await getDoc(studentDocRef);
                if (studentDoc.exists()) {
                    renderModal('editStudent', { student: studentDoc.data() });
                    const confirmBtn = document.getElementById('confirm-edit-student-btn');
                    confirmBtn.dataset.classId = classId;
                    confirmBtn.dataset.studentId = studentId;
                }
            } catch (e) { console.error("Error fetching student for edit:", e); }
        }

        async function handleSaveStudentEdit() {
            const confirmBtn = document.getElementById('confirm-edit-student-btn');
            const { classId, studentId } = confirmBtn.dataset;
            const newSeat = parseInt(document.getElementById('edit-student-seat').value);
            const newName = document.getElementById('edit-student-name').value.trim();
            const errorEl = document.getElementById('edit-student-error');

            if (!newName || isNaN(newSeat)) { errorEl.textContent = '座號與姓名不可為空。'; return; }

            const studentsRef = collection(db, `classes/${classId}/students`);
            const seatQuery = query(studentsRef, where("seatNumber", "==", newSeat), limit(1));
            const seatSnapshot = await getDocs(seatQuery);
            if (!seatSnapshot.empty && seatSnapshot.docs[0].id !== studentId) {
                errorEl.textContent = '該座號已被其他學子使用。';
                return;
            }

            try {
                const studentDocRef = doc(studentsRef, studentId);
                await updateDoc(studentDocRef, { name: newName, seatNumber: newSeat });
                closeModal();
                renderModal('message', { type: 'success', title: '更新成功', message: '學籍資料已更新！' });
                updateRosterDisplay(classId); // Refresh roster
            } catch (e) {
                console.error("更新學生失敗:", e);
                errorEl.textContent = '更新失敗，請稍後再試。';
            }
        }

        async function handleDeleteStudent(classId, studentId) {
            try {
                const studentDoc = await getDoc(doc(db, `classes/${classId}/students`, studentId));
                const studentName = studentDoc.exists() ? studentDoc.data().name : '該位學子';
                
                renderModal('deleteStudentConfirm', {
                    studentName: studentName,
                    classId: classId,
                    studentId: studentId
                });
            } catch (error) {
                console.error("Error preparing student deletion:", error);
                renderModal('message', { title: '錯誤', message: '準備刪除作業時發生錯誤。' });
            }
        }

        async function confirmDeleteStudent() {
            const confirmBtn = document.getElementById('confirm-delete-student-btn');
            const { classId, studentId } = confirmBtn.dataset;
            
            closeModal();
            showLoading('正在刪除學子及其記錄...');

            try {
                const batch = writeBatch(db);
                
                // 1. Delete the student document itself
                const studentDocRef = doc(db, `classes/${classId}/students`, studentId);
                batch.delete(studentDocRef);

                // 2. Find and delete all submissions by this student
                const submissionsQuery = query(collection(db, "submissions"), where("studentId", "==", studentId));
                const submissionsSnapshot = await getDocs(submissionsQuery);
                submissionsSnapshot.forEach(doc => {
                    batch.delete(doc.ref);
                });

                // 3. Find and delete all achievements by this student
                const achievementsQuery = query(collection(db, "student_achievements"), where("studentId", "==", studentId));
                const achievementsSnapshot = await getDocs(achievementsQuery);
                achievementsSnapshot.forEach(doc => {
                    batch.delete(doc.ref);
                });

                // 4. Commit all batched writes
                await batch.commit();
                
                renderModal('message', { type: 'success', title: '除籍成功', message: '學子已成功除籍。' });
                updateRosterDisplay(classId); // Refresh the roster view

            } catch (e) {
                console.error("刪除學生失敗:", e);
                renderModal('message', { type: 'error', title: '刪除失敗', message: '操作失敗，請檢查主控台錯誤訊息。' });
            } finally {
                hideLoading();
            }
        }


        async function handleEditArticle(e) {
            const articleId = e.target.closest('[data-assignment-id]')?.dataset.assignmentId;
            if (!articleId) {
                console.error("handleEditArticle: Could not find articleId from event target.");
                return;
            }
            
            // First, try to find it in any of the loaded states for performance
            let article = appState.teacherArticleQueryState.articles.find(a => a.id === articleId)
                       || appState.assignments.find(a => a.id === articleId)
                       || (appState.allTeacherArticles || []).find(a => a.id === articleId);

            if (article) {
                console.log('Rendering editArticle modal with assignment:', article);
                console.log('isPublic value:', article.isPublic);
                renderModal('editArticle', { assignment: article });
            } else {
                // If not found, fetch it directly from Firestore as a robust fallback
                showLoading('正在讀取篇章資料...');
                try {
                    const docRef = doc(db, "assignments", articleId);
                    const docSnap = await getDoc(docRef);
                    if (docSnap.exists()) {
                        article = { id: docSnap.id, ...docSnap.data() };
                        renderModal('editArticle', { assignment: article });
                    } else {
                        renderModal('message', { type: 'error', title: '錯誤', message: '找不到該篇章的資料。' });
                    }
                } catch (err) {
                    console.error("Error fetching article directly:", err);
                    renderModal('message', { type: 'error', title: '錯誤', message: '讀取篇章資料時發生錯誤。' });
                } finally {
                    hideLoading();
                }
            }
        }

        // 批次更新文章公開狀態
        async function bulkUpdatePublicStatus(isPublic) {
            const selectedCheckboxes = document.querySelectorAll('.article-checkbox:checked');
            if (selectedCheckboxes.length === 0) {
                renderModal('message', { type: 'info', title: '提示', message: '請先選取要操作的文章。' });
                return;
            }

            const articleIds = Array.from(selectedCheckboxes).map(cb => cb.value);
            const statusText = isPublic ? '公開' : '私密';

            renderModal('confirm', {
                title: '確認批次更新',
                message: `確定要將 ${articleIds.length} 篇文章設為${statusText}嗎？`,
                onConfirm: async () => {
                    showLoading('批次更新中...');

                    try {
                        const batch = writeBatch(db);

                        articleIds.forEach(articleId => {
                            const articleRef = doc(db, "assignments", articleId);
                            batch.update(articleRef, { isPublic: isPublic });
                        });

                        await batch.commit();
                        renderModal('message', { type: 'success', title: '更新成功', message: `成功將 ${articleIds.length} 篇文章設為${statusText}。` });
                        await fetchTeacherAssignmentsPage(true); // Refresh list
                    } catch (error) {
                        console.error(`批次更新文章狀態失敗:`, error);
                        renderModal('message', { type: 'error', title: '批次更新失敗', message: '批次更新失敗，請稍後再試。' });
                    } finally {
                        hideLoading();
                        // Reset UI
                        const bulkContainer = document.getElementById('bulk-actions-container');
                        if (bulkContainer) bulkContainer.classList.add('hidden');
                        const selectAll = document.getElementById('select-all-articles');
                        if (selectAll) selectAll.checked = false;
                        document.querySelectorAll('.article-checkbox').forEach(cb => cb.checked = false);
                    }
                }
            });
        }

        async function handleDeleteArticle(e) {
            const articleId = e.target.dataset.assignmentId;
            if (!articleId) { renderModal('message', { type: 'error', title: '操作錯誤', message: '找不到篇章 ID。' }); return; }
            const article = appState.assignments.find(a => a.id === articleId);

            renderModal('confirm', {
                title: '確認刪除篇章',
                message: `您確定要刪除篇章「${article.title}」嗎？此舉將一併移除所有學子的相關挑戰記錄，且無法復原。`,
                onConfirm: async () => {
                    showLoading('正在刪除篇章及其所有挑戰記錄...');
                    try {
                        const batch = writeBatch(db);
                        batch.delete(doc(db, `assignments`, articleId));
                        const submissionsQuery = query(collection(db, "submissions"), where("assignmentId", "==", articleId));
                        const submissionsSnapshot = await getDocs(submissionsQuery);
                        submissionsSnapshot.forEach(d => batch.delete(d.ref));
                        await batch.commit();
                        appState.assignments = appState.assignments.filter(a => a.id !== articleId);
                        // Instead of re-rendering the whole table, just remove the element from the DOM
                        const articleElement = document.querySelector(`[data-assignment-id="${articleId}"]`);
                        if (articleElement) {
                            articleElement.remove();
                        }

                        // Hide the analysis panel if it's visible
                        const analysisPanel = document.getElementById('analysis-panel');
                        if (analysisPanel) {
                            analysisPanel.classList.add('hidden');
                        }
                        renderModal('message', { type: 'success', title: '刪除成功', message: `篇章「${article.title}」已刪除。` });
                    } catch (e) {
                        console.error("刪除文章失敗:", e);
                        renderModal('message', { type: 'error', title: '刪除失敗', message: '操作失敗，請稍後再試。' });
                    } finally {
                        hideLoading();
                    }
                }
            });
        }

        async function handleBulkDelete() {
            const selectedIds = Array.from(document.querySelectorAll('.article-checkbox:checked')).map(cb => cb.value);
            if (selectedIds.length === 0) {
                renderModal('message', { type: 'info', title: '提示', message: '請至少選取一個要刪除的篇章。' });
                return;
            }

            renderModal('confirm', {
                title: '確認批次刪除',
                message: `您確定要刪除選取的 ${selectedIds.length} 個篇章嗎？此舉將一併移除所有相關的學子作答記錄，且無法復原。`,
                onConfirm: async () => {
                    showLoading(`正在刪除 ${selectedIds.length} 個篇章...`);
                    try {
                        const batch = writeBatch(db);
                        for (const articleId of selectedIds) {
                            batch.delete(doc(db, `assignments`, articleId));
                            const submissionsQuery = query(collection(db, "submissions"), where("assignmentId", "==", articleId));
                            const submissionsSnapshot = await getDocs(submissionsQuery);
                            submissionsSnapshot.forEach(d => batch.delete(d.ref));
                        }
                        await batch.commit();
                        appState.assignments = appState.assignments.filter(a => !selectedIds.includes(a.id));
                        renderTeacherArticleTable(appState.assignments, true);
                        document.getElementById('analysis-panel').classList.add('hidden');
                        document.getElementById('select-all-articles').checked = false;
                        document.getElementById('bulk-actions-container').classList.add('hidden');
                        renderModal('message', { type: 'success', title: '批次刪除成功', message: `已成功刪除 ${selectedIds.length} 個篇章。` });
                    } catch (e) {
                        console.error("批次刪除文章失敗:", e);
                        renderModal('message', { type: 'error', title: '批次刪除失敗', message: '操作失敗，請檢查主控台錯誤訊息。' });
                    } finally {
                        hideLoading();
                    }
                }
            });
        }
        
        function getRandomOption(selectId) {
            const select = document.getElementById(selectId);
            const options = Array.from(select.options).slice(1); // Exclude "AI 自動判斷"
            return options[Math.floor(Math.random() * options.length)].value;
        }

        function getDifficultyInstructions(difficulty) {
            switch (difficulty) {
                case '簡單':
                    return `*   **文章風格**: 詞彙具體，以常用字為主（符合台灣教育部頒布之常用字標準）。句式簡短，多為單句或簡單複句。主題貼近日常生活經驗。篇幅約 400-600 字。\n*   **試題風格**: 題目多為「擷取與檢索」層次，答案可直接在文章中找到。選項與原文用字高度相似。`;
                case '基礎':
                    return `*   **文章風格**: 詞彙淺白易懂，句式以簡單複句為主。主題明確，結構為總分總。篇幅約 600-700 字。\n*   **試題風格**: 題目以「擷取與檢索」和淺層的「統整與解釋」為主，需要對段落進行簡單歸納。`;
                case '普通':
                    return `*   **文章風格**: **以「台灣國中教育會考國文科」的平均難度為基準**。詞彙量適中，包含少量成語或較正式的書面語。句式長短錯落，開始出現較複雜的從屬句。主題可能涉及社會、自然、人文等領域。篇幅約 600-800 字。\n*   **試題風格**: 題目均衡分佈於 PISA 三層次，特別著重「統整與解釋」，需要理解段落主旨、文意轉折。`;
                case '進階':
                    return `*   **文章風格**: 詞彙量豐富，包含較多抽象詞彙、成語及修辭技巧。句式複雜，多長句和多層次的複句。主題可能具有思辨性或專業性。篇幅約 800-1000 字。\n*   **試題風格**: 題目以「統整與解釋」和「省思與評鑑」為主，需要進行跨段落的訊息整合、推論作者觀點或評論文章內容。`;
                case '困難':
                    return `*   **文章風格**: 詞彙精深，可能包含少量文言詞彙或專業術語。句式精鍊且高度複雜，可能使用非線性敘事或象徵手法。主題抽象，需要讀者具備相應的背景知識。篇幅約 1000-1200 字。\n*   **試題風格**: 題目以「省思與評鑑」為主，要求批判性思考，如評鑑論點的說服力、分析寫作手法的效果，或結合自身經驗進行評價。`;
                default:
                    return `*   **文章風格**: 以「台灣國中教育會考國文科」的平均難度為基準。詞彙量適中，句式長短錯落。篇幅約 600-800 字。\n*   **試題風格**: 題目均衡分佈於 PISA 三層次。`;
            }
        }

        async function generateAssignment() {
            const topic = document.getElementById('topic-input').value.trim();
            const deadline = document.getElementById('deadline-input').value;
            if (!topic) { renderModal('message', { type: 'error', title: '生成失敗', message: '請輸入篇章主題！' }); return; }
            
            const tagFormat = document.getElementById('tag-format-input').value || getRandomOption('tag-format-input');
            const tagContentType = document.getElementById('tag-contentType-input').value || getRandomOption('tag-contentType-input');
            const tagDifficulty = document.getElementById('tag-difficulty-input').value || getRandomOption('tag-difficulty-input');
            
            const difficultyInstruction = getDifficultyInstructions(tagDifficulty);
            
            const contentTypeInstructions = {
                '記敘': '**寫作手法提醒：請務必使用記敘文體，包含明確的人物、時間、地點和事件經過，著重於故事的發展與情節的描述，避免使用過於客觀或分析性的說明語氣。**',
                '議論': '**寫作手法提醒：請務必使用議論文體，提出明確的論點，並使用例證、引證或數據來支持你的主張，結構上應包含引論、本論、結論。**',
                '抒情': '**寫作手法提醒：請務必使用抒情文體，透過細膩的描寫與譬喻、轉化等修辭手法，表達豐富的情感與想像，著重於意境的營造。**'
            };
            const styleInstruction = contentTypeInstructions[tagContentType] || '';

            let articleInstruction;
            const mermaidInstruction = `\n    * **圖表運用指南**：請優先考慮使用 **Mermaid.js 語法** 來建立視覺化圖表，以更生動地呈現資訊。
        * **圖表類型**：請根據內容選擇最合適的圖表，例如用 \`xychart-beta\` 呈現數據、用 \`flowchart\` 展示流程、用 \`pie\` 顯示比例等。
        * **語法規則**：圖表語法需以 \`\`\`mermaid 開頭，以 \`\`\` 結尾。
        * **換行技巧**：在 \`xychart-beta\` 中，如果 X 軸的標籤文字過長，請在字串內使用 "<br>" 標籤來手動換行。
        * **備用方案**：如果內容不適合複雜圖表，也可以使用 GFM (GitHub Flavored Markdown) 格式的表格。`;

            if (tagFormat === '圖表') {
                articleInstruction = `**請以一個主要的 Mermaid 圖表或 Markdown 表格作為文章核心**。所有文字內容應是針對此圖表的簡潔說明，重點在於測驗學生詮釋圖表資訊的能力。${mermaidInstruction}`;
            } else if (tagFormat === '圖文') {
                articleInstruction = `撰寫一篇優質連續文本文章，內容需清晰、有深度、層次分明，且**務必分段**。**請務必在文章內容中，插入一個以上與主題相關、能輔助說明的 Mermaid 圖表或 Markdown 表格**，用以測驗圖文整合能力。${mermaidInstruction}`;
            } else { // 純文
                articleInstruction = `撰寫一篇優質文章，內容需清晰、有深度、層次分明，且**務必分段**。`;
            }

            showLoading(`AI 書僮正在設計篇章...`);

            let questionLevelInstruction = '題目層次分配如下：第 1 題：**擷取與檢索**。第 2、3 題：**統整與解釋**。第 4、5 題：**省思與評鑑**。';
            const suitableContentTypes = new Set(['記敘', '抒情', '議論']);
            if (suitableContentTypes.has(tagContentType) && Math.random() < 0.4) { // 40% 機率考寫作手法
                const techniqueQuestionPosition = Math.random() < 0.5 ? 4 : 5; // 隨機選第4或第5題
                if (techniqueQuestionPosition === 4) {
                    questionLevelInstruction = '題目層次分配如下：第 1 題：**擷取與檢索**。第 2、3 題：**統整與解釋**。第 4 題：**寫作手法分析** (請針對本文使用的一種主要或特殊寫作手法進行提問)。第 5 題：**省思與評鑑**。';
                } else {
                    questionLevelInstruction = '題目層次分配如下：第 1 題：**擷取與檢索**。第 2、3 題：**統整與解釋**。第 4 題：**省思與評鑑**。第 5 題：**寫作手法分析** (請針對本文使用的一種主要或特殊寫作手法進行提問)。';
                }
            }

            const prompt = `你是一位專為台灣國中生出題的資深國文科老師，請設計一份素養導向的閱讀測驗。所有文本與試題的難度應以「普通」難度作為「國中教育會考」的基準，再根據使用者指定的難度標籤，適度調整文章長度、詞彙深度、句式複雜度與題目鑑別度。
主題：「${topic}」
請遵循以下專業要求：
1.  **篇章撰寫**：
    * **根據主題「${topic}」，發想一個更能吸引學生的正式標題(title)，但不可使用誇張或內容農場式的風格。**
	* **所有連續文本文字段落（包含第一段）的開頭都必須加上兩個全形空格「　　」來進行縮排。如果是詩歌體則不用。**
	 * **連續文本文字段落間請務必空一行。**
    * ${styleInstruction}
    * **難度指引**:
${difficultyInstruction}
    * ${articleInstruction}
    * **絕不使用圖片或圖片語法**。
2.  **試煉設計**：
    * 根據篇章，設計 5 道符合 PISA 閱讀素養三層次的單選題。
    * **試題必須是素養導向的**，旨在考驗學子的歸納、分析、批判與應用能力，而非僅是記憶。
    * **試題必須是客觀題，答案能直接或間接從文本中找到，絕不可出現『你認為』、『你覺得』等開放式問句。**
    * **選項必須具有高誘答力**，錯誤選項需看似合理，能鑑別出學子的迷思概念。
    * ${questionLevelInstruction}
3.  **標籤要求**：
    * **形式**: 請生成「${tagFormat}」形式的內容。
    * **內容**: 請生成「${tagContentType}」類型的內容。
    * **難度**: 請嚴格遵循上方的「難度指引」來生成「${tagDifficulty}」難度的內容，並將此難度作為標籤。
4.  **產出格式**：請嚴格按照指定的 JSON 格式輸出，不要包含 JSON 格式以外的任何文字。`;
            const schema = {type:"OBJECT",properties:{title:{type:"STRING"},article:{type:"STRING"},questions:{type:"ARRAY",items:{type:"OBJECT",properties:{questionText:{type:"STRING"},options:{type:"ARRAY",items:{type:"STRING"}},correctAnswerIndex:{type:"NUMBER"},explanation:{type:"STRING"}},required:["questionText","options","correctAnswerIndex","explanation"]}},tags:{type:"OBJECT",properties:{format:{type:"STRING"},contentType:{type:"STRING"},difficulty:{type:"STRING"}},required:["format","contentType","difficulty"]}},required:["title","article","questions","tags"]};
            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema } };
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${appState.geminiModel}:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!response.ok) throw new Error(`API 請求失敗`);
                const result = await response.json();
                if (result.candidates?.length > 0) {
                    const content = JSON.parse(result.candidates[0].content.parts[0].text);
                    
                    showLoading('AI 書僮正在生成深度解析...');
                    const analysis = await callFullGeminiAnalysis(content.article);

                    const newAssignment = { ...content, analysis: analysis, createdAt: new Date(), isPublic: document.getElementById('ai-is-public').checked };
                    if (deadline) newAssignment.deadline = Timestamp.fromDate(new Date(deadline + "T23:59:59"));
                    
                    await addDoc(collection(db, `assignments`), newAssignment);
                    await getAssignments(true); // Force refresh cache
                    document.getElementById('topic-input').value = '';
                    document.getElementById('deadline-input').value = '';
                    // Also refresh teacher view if active
                    if (appState.currentView === 'teacher') {
                        fetchTeacherAssignmentsPage(true);
                    }
                } else { throw new Error("API 未返回有效內容。"); }
            } catch (error) { console.error("生成文章失敗:", error); renderModal('message', { type: 'error', title: '生成失敗', message: '操作失敗，請稍後再試。' }); } 
            finally { hideLoading(); }
        }


async function callGeminiAPI(article) {
    if (!appState.geminiApiKey) {
        throw new Error("AI API 金鑰未設定。");
    }
    const apiKey = appState.geminiApiKey;
    const prompt = `請針對以下文章進行深度解析，並嚴格依照以下 JSON 格式回傳：
{
  "mindmap": "（請在此處生成 Mermaid 的 markdown 格式心智圖，總結文章的重點）",
  "explanation": "（請在此處生成文章的深度解析，分析其主旨、結構、風格）",
  "thinking_questions": [
    "（請在此處生成第一個延伸思考問題）",
    "（請在此處生成第二個延伸思考問題）",
    "（請在此處生成第三個延伸思考問題）"
  ]
}

文章內容如下：
${article}`;
    const payload = {
        contents: [{
            role: "user",
            parts: [{
                text: prompt
            }]
        }]
    };
    let response;
    for (let i = 0; i < 3; i++) {
        response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${appState.geminiModel}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (response.ok) {
            break;
        }
        if (response.status === 503 && i < 2) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        } else {
            break;
        }
    }

    if (!response.ok) {
        throw new Error(`API 請求失敗`);
    }
    const result = await response.json();
    if (result.candidates?.length > 0 && result.candidates[0].content.parts?.length > 0) {
        const text = result.candidates[0].content.parts[0].text;
        const cleanedText = text.replace(/```json/g, '').replace(/```/g, '');
        return JSON.parse(cleanedText);
    } else {
        console.error("API response is missing expected structure:", result);
        throw new Error("API 未返回有效內容或內容結構不符。");
    }
}



async function handleGenerateQuestionsFromPasted() {
            const title = document.getElementById('pasted-title-input').value.trim();
            const article = document.getElementById('pasted-article-textarea').value.trim();
            const deadline = document.getElementById('pasted-deadline-input').value;
            if (!title || !article) { renderModal('message', { type: 'error', title: '生成失敗', message: '請輸入標題和文章內容！' }); return; }
            
            const tagFormat = document.getElementById('pasted-tag-format-input').value;
            const tagContentType = document.getElementById('pasted-tag-contentType-input').value;
            const tagDifficulty = document.getElementById('pasted-tag-difficulty-input').value;
            let tagInstruction;
            if (tagFormat || tagContentType || tagDifficulty) {
                tagInstruction = "請參考以下指定的標籤來判斷文章屬性，若有衝突以文章內容為準。";
                if (tagFormat) tagInstruction += ` 形式參考：「${tagFormat}」。`;
                if (tagContentType) tagInstruction += ` 內容參考：「${tagContentType}」。`;
                if (tagDifficulty) tagInstruction += ` 難度參考：「${tagDifficulty}」。`;
            } else {
                tagInstruction = `請你根據提供的文章內容，從「形式」、「內容」、「難度」三個類別中，各選擇一個最適合的標籤。**絕不可以創造選項之外的新標籤**。`;
            }

            showLoading(`AI 正在分析文本並生成試題...`);
            const prompt = `你是一位學養深厚的書院夫子。請根據以下提供的篇章，為其設計 5 道符合 PISA 閱讀素養的單選試題，並判斷其標籤。
請遵循以下專業要求：
1.  **試題設計**：
    * **試題必須是素養導向的**，旨在考驗學子的歸納、分析、批判與應用能力。
    * **試題必須是客觀題，答案能直接或間接從文本中找到，絕不可出現『你認為』、『你覺得』等開放式問句。**
    * 試題層次分配如下：第 1 題：**擷取與檢索**。第 2、3 題：**統整與解釋**。第 4、5 題：**省思與評鑑**。
2.  **JSON 結構說明 (極度重要)**：
    * **\`options\`**：這是一個包含四個字串的陣列，代表四個選項。
    * **\`correctAnswerIndex\`**：這是一個**數字**，代表正確答案在 \`options\` 陣列中的**索引 (index)**。索引從 0 開始計算。
    * **範例**：如果 \`options\` 是 \`["貓", "狗", "鳥", "魚"]\`，而正確答案是 "鳥"，那麼 \`correctAnswerIndex\` **必須**是 \`2\`。
    * **隨機性要求**：請務必確保正確答案在 \`options\` 陣列中的位置是隨機的，因此 \`correctAnswerIndex\` 的值 (0, 1, 2, 3) 也必須是隨機出現的。
3.  **標籤要求**：
    * ${tagInstruction}
    * **形式選項與解讀**: 「純文」(連續文本)、「圖表」(以圖表為主，文字為輔)、「圖文」(以連續文本為主，圖表為輔)。
    * **內容選項**: 「記敘」、「抒情」、「說明」、「議論」、「應用」。
    * **難度選項與解讀**: 「簡單」、「基礎」、「普通」、「進階」、「困難」。**特別注意：如果篇章包含文言文，其難度至少應從「進階」起跳。**
4.  **產出格式**：嚴格按照指定的 JSON 格式輸出，僅包含 questions 和 tags 兩個 key。
---
**篇章內容如下**：\`\`\`${article}\`\`\``;
            const schema = {type:"OBJECT",properties:{questions:{type:"ARRAY",items:{type:"OBJECT",properties:{questionText:{type:"STRING"},options:{type:"ARRAY",items:{type:"STRING"}},correctAnswerIndex:{type:"NUMBER"},explanation:{type:"STRING"}},required:["questionText","options","correctAnswerIndex","explanation"]}},tags:{type:"OBJECT",properties:{format:{type:"STRING"},contentType:{type:"STRING"},difficulty:{type:"STRING"}},required:["format","contentType","difficulty"]}},required:["questions","tags"]};
            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: schema } };
                
                let response;
                for (let i = 0; i < 3; i++) {
                    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${appState.geminiModel}:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                    if (response.ok) {
                        break;
                    }
                    if (response.status === 503 && i < 2) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
                    } else {
                        break;
                    }
                }

                if (!response.ok) throw new Error(`API 請求失敗`);
                const result = await response.json();
                if (result.candidates?.length > 0) {
                    const content = JSON.parse(result.candidates[0].content.parts[0].text);

                    showLoading('AI 書僮正在生成深度解析...');
                    const analysis = await callFullGeminiAnalysis(article);

                    const newAssignment = { title, article, ...content, analysis: analysis, createdAt: new Date(), isPublic: document.getElementById('pasted-is-public').checked };
                    if (deadline) newAssignment.deadline = Timestamp.fromDate(new Date(deadline + "T23:59:59"));
                    await addDoc(collection(db, `assignments`), newAssignment);
                    await getAssignments(true); // Force refresh cache
                    document.getElementById('pasted-title-input').value = '';
                    document.getElementById('pasted-article-textarea').value = '';
                    document.getElementById('pasted-deadline-input').value = '';
                    renderModal('message', { type: 'success', title: '生成成功', message: '試題已成功生成並儲存！' });
                    if (appState.currentView === 'teacher') {
                        fetchTeacherAssignmentsPage(true);
                    }
                } else { throw new Error("API 未返回有效內容。"); }
            } catch (error) { console.error("生成試題失敗:", error); renderModal('message', { type: 'error', title: '生成失敗', message: '操作失敗，請稍後再試。' }); } 
            finally { hideLoading(); }
        }
        
        async function handleAiAnalysis(articleId) {
            if (!articleId) {
                renderModal('message', { type: 'error', title: '錯誤', message: '缺少文章 ID，無法進行分析。' });
                return;
            }
            const article = appState.assignments.find(a => a.id === articleId);
            const selectedClassId = document.getElementById('class-selector').value;
            if (!selectedClassId) { renderModal('message', { type: 'info', title: '提示', message: '請先選擇一個學堂以進行分析。' }); return; }
            const selectedClass = appState.allClasses.find(c => c.id === selectedClassId);
            const submissions = appState.allSubmissions.filter(s => s.assignmentId === articleId && s.classId === selectedClassId);
            if (submissions.length < 1) { renderModal('message', { type: 'info', title: '提示', message: '該學堂至少需要1位學子的挑戰記錄才能進行有效分析。' }); return; }
            showLoading(`AI 書僮正在分析學堂數據...`);
            const analysisData = article.questions.map((q, q_idx) => {
                const answerCounts = q.options.map(() => 0); 
                let correctCount = 0;
                submissions.forEach(s => { 
                    const answerIdx = s.answers[q_idx]; 
                    if (answerIdx !== null && answerIdx < answerCounts.length) answerCounts[answerIdx]++; 
                    if (answerIdx === q.correctAnswerIndex) correctCount++; 
                });
                return { question: q.questionText, options: q.options, correctAnswer: q.options[q.correctAnswerIndex], totalAnswers: submissions.length, correctCount, answerDistribution: answerCounts };
            });
            const teacherName = appState.currentUser.name || '老師';
            const today = new Date();
            const reportDate = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
            const prompt = `身為一位洞察敏銳的書院夫子，請根據以下這份閱讀試煉的作答數據，為${teacherName}夫子提供一份專業、深入的教學策勵。
---
**課業基本資料**
- **策勵對象**: ${teacherName}夫子
- **分析者**: 書院教學輔佐
- **報告日期**: ${reportDate}
- **試煉篇章**: 《${article.title}》
- **受試學堂**: ${selectedClass.className}
- **應試人數**: ${submissions.length} 人
---
**學子作答數據**
\`\`\`json
${JSON.stringify(analysisData, null, 2)}
\`\`\`
---
**策勵撰寫要求**
1.  **引言**: 簡要說明本次試煉的整體表現。
2.  **逐題分析**: 深入探討高誘答率的錯誤選項，分析學子可能的學習盲點。
3.  **綜合評估與教學建議**：總結學子在 PISA 三層次上的整體表現，並提出 2-3 點具體、可行的教學方向。
4.  **格式**: 請使用 Markdown 格式，讓報告清晰易讀，並帶有鼓勵與專業的語氣。`;
            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!response.ok) throw new Error(`API 請求失敗`);
                const result = await response.json();
                if (result.candidates?.length > 0) {
                    const analysisText = result.candidates[0].content.parts[0].text;
                    renderModal('aiAnalysis', { analysisText });
                } else { throw new Error("API 未返回有效內容。"); }
            } catch (error) { console.error("AI 分析失敗:", error); renderModal('message', { type: 'error', title: '分析失敗', message: 'AI 分析失敗，請稍後再試。' }); } 
            finally { hideLoading(); }
        }

        async function renderCalendar() {
            const calendarEl = document.getElementById('calendar-view');
            if (!calendarEl) return;

            const allAssignments = await getAssignments();

            appState.calendarDisplayDate = appState.calendarDisplayDate || new Date();
            const displayDate = appState.calendarDisplayDate;

            const year = displayDate.getFullYear();
            const month = displayDate.getMonth();

            const firstDay = new Date(year, month, 1);
            const lastDay = new Date(year, month + 1, 0);
            const firstDayIndex = firstDay.getDay();
            const daysInMonth = lastDay.getDate();

            const now = new Date();
            const today = (now.getFullYear() === year && now.getMonth() === month) ? now.getDate() : -1;

            let header = `
                <div class="flex justify-between items-center mb-2">
                    <button id="prev-month-btn" class="p-1 rounded-full hover:bg-gray-200"><</button>
                    <h4 class="font-bold">${year}年 ${month + 1}月</h4>
                    <button id="next-month-btn" class="p-1 rounded-full hover:bg-gray-200">></button>
                </div>`;

            let weekDays = `<div class="grid grid-cols-7 gap-1 text-center text-xs text-slate-500">` + ['日', '一', '二', '三', '四', '五', '六'].map(d => `<div>${d}</div>`).join('') + `</div>`;
            
            let daysGrid = `<div class="grid grid-cols-7 gap-1 mt-2">`;
            for (let i = 0; i < firstDayIndex; i++) daysGrid += `<div></div>`;

            for (let day = 1; day <= daysInMonth; day++) {
                const dayString = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const deadlines = allAssignments.filter(a => {
                    const isStudentUser = appState.currentUser?.type === 'student';
                    if (isStudentUser && a.isPublic !== true) {
                        return false;
                    }
                    return a.deadline && a.deadline.toDate().toISOString().startsWith(dayString);
                });
                
                let dayClasses = "h-9 flex items-center justify-center rounded-full text-sm relative cursor-pointer hover:bg-gray-100";
                if (day === today) {
                    dayClasses += " bg-gray-800 text-white font-bold is-today";
                }
                
                let deadlineMarkers = deadlines.map(() => `<div class="absolute bottom-1 w-1.5 h-1.5 bg-red-500 rounded-full"></div>`).join('');
                daysGrid += `<div data-date="${dayString}" class="calendar-day ${dayClasses}">${day}${deadlineMarkers}</div>`;
            }
            daysGrid += `</div>`;

            calendarEl.innerHTML = header + weekDays + daysGrid;

            // Event Listeners
            calendarEl.querySelectorAll('.calendar-day').forEach(dayEl => {
                dayEl.addEventListener('click', (e) => {
                    const target = e.currentTarget;
                    appState.calendarFilterDate = target.dataset.date;

                    // Visually mark the selected day
                    // Visually mark the selected day, while correctly handling the "today" style
                    calendarEl.querySelectorAll('.calendar-day').forEach(d => {
                        // Remove selection-related styles from all days
                        d.classList.remove('bg-red-700', 'text-white');
                        
                        // If the day is 'today', ensure its original style is restored.
                        if (d.classList.contains('is-today')) {
                           d.classList.add('bg-gray-800', 'text-white', 'font-bold');
                        }
                    });
                    
                    // Add selection style to the clicked day. This will override the 'today' style if needed.
                    target.classList.add('bg-red-700', 'text-white');

                    // Reset other filters
                    document.getElementById('filter-format').value = '';
                    document.getElementById('filter-contentType').value = '';
                    document.getElementById('filter-difficulty').value = '';
                    document.getElementById('filter-status').value = '';
                    appState.articleQueryState.filters = { format: '', contentType: '', difficulty: '', status: '' };

                    // Fetch assignments for the selected date
                    fetchAssignmentsPage(true);
                });
            });

            const prevBtn = document.getElementById('prev-month-btn');
            const nextBtn = document.getElementById('next-month-btn');

            if (prevBtn && nextBtn) {
                prevBtn.addEventListener('click', () => {
                    appState.calendarDisplayDate.setMonth(appState.calendarDisplayDate.getMonth() - 1);
                    renderCalendar();
                });

                nextBtn.addEventListener('click', () => {
                    appState.calendarDisplayDate.setMonth(appState.calendarDisplayDate.getMonth() + 1);
                    renderCalendar();
                });
            }
        }
        
        function renderAssignmentsList(assignmentsToRender) {
            const listEl = document.getElementById('assignments-list');
            if (!listEl) return;

            listEl.innerHTML = ''; // Clear previous content

            if (assignmentsToRender.length === 0) {
                listEl.appendChild(el('p', { class: 'text-slate-500 text-center py-4', textContent: '太棒了！沒有設定期限的緊急任務。' }));
                return;
            }

            const fragment = document.createDocumentFragment();
            assignmentsToRender.forEach(assignment => {
                const deadlineDate = assignment.deadline.toDate();
                const isOverdue = new Date() > deadlineDate;
                const deadlineInfo = el('div', { class: 'mt-2 text-sm' });

                if (isOverdue) {
                    deadlineInfo.appendChild(el('span', { class: 'text-xs font-bold text-red-500', textContent: '已過期' }));
                } else {
                    deadlineInfo.appendChild(el('span', { class: 'text-xs text-slate-500', textContent: `期限: ${deadlineDate.getMonth()+1}/${deadlineDate.getDate()}` }));
                }
                const statusBorderClass = isOverdue ? 'status-border-overdue' : 'status-border-incomplete';
                const item = el('div', {
                    id: `assignment-list-item-${assignment.id}`,
                    'data-assignment-id': assignment.id,
                    class: `assignment-item ${statusBorderClass} p-4 bg-white border-y-2 border-r-2 border-l-0 border-slate-200 rounded-lg shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer`
                }, [
                    el('div', { class: 'flex justify-between items-center gap-3' }, [
                        el('div', { class: 'flex-grow' }, [
                            el('h3', { class: 'font-semibold text-slate-800', textContent: assignment.title }),
                            deadlineInfo
                        ])
                    ])
                ]);
                item.addEventListener('click', () => displayAssignment(assignment));
                fragment.appendChild(item);
            });
            listEl.appendChild(fragment);
        }

        async function fetchAssignmentsPage(isNewQuery = false) {
            const state = appState.articleQueryState;
            if (state.isLoading || (!isNewQuery && state.isLastPage)) return;

            state.isLoading = true;
            if (isNewQuery) {
                state.isLastPage = false;
                appState.assignments = [];
            }
            showLoading('正在擷取篇章...');

            try {
                const allAssignments = await getAssignments();
                const filters = state.filters;

                let filteredAssignments = allAssignments.filter(a => {
                    // For student-type users, only show public assignments. Teachers can see all.
                    const isStudentUser = appState.currentUser?.type === 'student';
                    if (isStudentUser && a.isPublic !== true) {
                        return false;
                    }

                    if (appState.calendarFilterDate) {
                        if (!a.deadline) return false;
                        const aDate = a.deadline.toDate().toISOString().split('T')[0];
                        return aDate === appState.calendarFilterDate;
                    }
                    if (filters.format && a.tags?.format !== filters.format) return false;
                    if (filters.contentType && a.tags?.contentType !== filters.contentType) return false;
                    if (filters.difficulty && a.tags?.difficulty !== filters.difficulty) return false;
                    if (filters.status) {
                        const completedIds = new Set(appState.allSubmissions.map(s => s.assignmentId));
                        const isCompleted = completedIds.has(a.id);
                        if (filters.status === 'complete' && !isCompleted) return false;
                        if (filters.status === 'incomplete' && isCompleted) return false;
                    }
                    return true;
                });

                const startIndex = isNewQuery ? 0 : appState.assignments.length;
                const newAssignments = filteredAssignments.slice(startIndex, startIndex + ARTICLES_PER_PAGE);

                if (newAssignments.length < ARTICLES_PER_PAGE || (startIndex + newAssignments.length) >= filteredAssignments.length) {
                    state.isLastPage = true;
                }

                if (isNewQuery) {
                    appState.assignments = newAssignments;
                } else {
                    appState.assignments.push(...newAssignments);
                }

                renderArticleGrid(newAssignments, isNewQuery);
                updateAssignedArticlesList();

            } catch (error) {
                console.error("Error fetching assignments:", error);
            } finally {
                state.isLoading = false;
                hideLoading();
            }
        }

        async function fetchTeacherAssignmentsPage(isNewQuery = false) {
            const state = appState.teacherArticleQueryState;
            if (state.isLoading) return;
            if (!isNewQuery && state.isLastPage) return;

            state.isLoading = true;
            updateTeacherLoadMoreButton();

            try {
                if (isNewQuery) {
                    state.articles = [];
                    state.isLastPage = false;
                    const assignmentsQuery = query(collection(db, "assignments"), orderBy("createdAt", "desc"));
                    const documentSnapshots = await getDocs(assignmentsQuery);
                    appState.allTeacherArticles = documentSnapshots.docs.map(doc => ({ ...doc.data(), id: doc.id }));
                }

                let filteredArticles = [...appState.allTeacherArticles];
                const filters = state.filters;

                if (filters.format) {
                    filteredArticles = filteredArticles.filter(a => a.tags?.format === filters.format);
                }
                if (filters.contentType) {
                    filteredArticles = filteredArticles.filter(a => a.tags?.contentType === filters.contentType);
                }
                if (filters.difficulty) {
                    filteredArticles = filteredArticles.filter(a => a.tags?.difficulty === filters.difficulty);
                }
                if (filters.searchTerm) {
                    filteredArticles = filteredArticles.filter(a => a.title && a.title.toLowerCase().includes(filters.searchTerm.toLowerCase()));
                }
                if (filters.deadlineStatus) {
                    const now = new Date();
                    filteredArticles = filteredArticles.filter(a => {
                        if (!a.deadline || typeof a.deadline.toDate !== 'function') {
                            return filters.deadlineStatus === 'none';
                        }
                        const deadline = a.deadline.toDate();
                        const isExpired = deadline <= now;
                        if (filters.deadlineStatus === 'active') return !isExpired;
                        if (filters.deadlineStatus === 'expired') return isExpired;
                        if (filters.deadlineStatus === 'none') return false;
                        return true;
                    });
                }

                const PAGE_SIZE = 15;
                const startIndex = state.articles.length;
                const endIndex = startIndex + PAGE_SIZE;
                const newAssignments = filteredArticles.slice(startIndex, endIndex);

                if (isNewQuery) {
                    state.articles = newAssignments;
                } else {
                    state.articles.push(...newAssignments);
                }
                
                state.isLastPage = state.articles.length >= filteredArticles.length;

                renderTeacherArticleTable(newAssignments, isNewQuery);

            } catch (error) {
                console.error("Error fetching teacher assignments:", error);
            } finally {
                state.isLoading = false;
                updateTeacherLoadMoreButton();
            }
        }

        function renderArticleGrid(assignments = [], isNewQuery = false) {
            const gridContainer = document.getElementById('article-grid-container');
            const paginationContainer = document.getElementById('pagination-container');
            if (!gridContainer) return;

            if (isNewQuery) {
                gridContainer.innerHTML = '';
            }

            if (assignments.length === 0 && isNewQuery) {
                gridContainer.appendChild(el('div', { class: 'col-span-full text-center py-12' }, [
                    el('h3', { class: 'text-xl text-slate-500', textContent: '找不到符合條件的篇章' }),
                    el('p', { class: 'text-slate-400 mt-2', textContent: '請試著調整篩選條件。' })
                ]));
            } else {
                const fragment = document.createDocumentFragment();
                assignments.forEach(assignment => {
                    fragment.appendChild(createFullArticleCard(assignment));
                });
                gridContainer.appendChild(fragment);
            }

            // Replace pagination with a "Load More" button
            if (paginationContainer) {
                paginationContainer.innerHTML = '';
                if (!appState.articleQueryState.isLastPage) {
                    const loadMoreBtn = el('button', { id: 'load-more-btn', class: 'btn-primary mx-auto py-2 px-6', textContent: '載入更多' });
                    loadMoreBtn.addEventListener('click', () => fetchAssignmentsPage(false));
                    paginationContainer.appendChild(loadMoreBtn);
                }
            }
        }

        async function updateAssignedArticlesList() {
            if (!appState.currentUser?.studentId) {
                renderAssignmentsList([]);
                return;
            }
            
            try {
                const allAssignments = await getAssignments();
                const userSubmissions = appState.allSubmissions.filter(s => s.studentId === appState.currentUser.studentId);
                const completedAssignmentIds = new Set(userSubmissions.map(s => s.assignmentId));

                const isStudentUser = appState.currentUser?.type === 'student';
                let assignmentsToRender = allAssignments.filter(a => {
                    // For student users, hide private articles. Teachers can see all.
                    if (isStudentUser && a.isPublic !== true) {
                        return false;
                    }
                    return a.deadline && !completedAssignmentIds.has(a.id);
                });
                assignmentsToRender.sort((a, b) => a.deadline.toMillis() - b.deadline.toMillis());

                renderAssignmentsList(assignmentsToRender);

            } catch (error) {
                console.error("Error updating assigned articles list:", error);
                renderAssignmentsList([]);
            }
        }

        async function getAssignments(forceRefresh = false) {
            const now = Date.now();
            const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

            if (!forceRefresh && appState.cache.assignments && (now - appState.cache.lastFetch < CACHE_DURATION)) {
                return appState.cache.assignments;
            }

            const assignmentsSnapshot = await getDocs(query(collection(db, "assignments"), orderBy("createdAt", "desc")));
            const assignments = assignmentsSnapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            
            appState.cache.assignments = assignments;
            appState.cache.lastFetch = now;
            
            return assignments;
        }

        function renderAnalysisContent(container, analysis) {
            container.innerHTML = ''; // Clear existing content
            if (analysis.mindmap) {
                container.appendChild(el('h2', { class: 'text-2xl font-bold mb-4', textContent: '心智圖' }));
                const mindmapDiv = el('div', { class: 'mermaid' }, [analysis.mindmap]);
                container.appendChild(mindmapDiv);
            }
            if (analysis.explanation) {
                container.appendChild(el('h2', { class: 'text-2xl font-bold mt-8 mb-4', textContent: '深度解析' }));
                container.appendChild(el('div', { innerHTML: markdownToHtml(analysis.explanation) }));
            }
            if (analysis.thinking_questions) {
                container.appendChild(el('h2', { class: 'text-2xl font-bold mt-8 mb-4', textContent: '延伸思考' }));
                container.appendChild(el('div', { innerHTML: markdownToHtml(analysis.thinking_questions) }));
            }
        }

        async function displayAssignment(assignment) {
            appState.currentAssignment = assignment;
            const contentDisplay = document.getElementById('content-display');
            contentDisplay.innerHTML = ''; // Clear previous content

            const submission = appState.currentUser?.studentId ? appState.allSubmissions.find(s => s.studentId === appState.currentUser.studentId && s.assignmentId === assignment.id) : null;
            const isCompleted = !!submission;
            const tags = assignment.tags || {};

            // Build tag elements
            const tagChildren = [];
            if (tags.format) tagChildren.push(el('span', { class: 'bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full font-medium', textContent: `#${tags.format}` }));
            if (tags.contentType) tagChildren.push(el('span', { class: 'bg-rose-100 text-rose-800 px-2 py-0.5 rounded-full font-medium', textContent: `#${tags.contentType}` }));
            if (tags.difficulty) tagChildren.push(el('span', { class: 'bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-medium', textContent: `#${tags.difficulty}` }));
            const tagContainer = el('div', { class: 'flex flex-wrap gap-2 text-xs mb-6' }, tagChildren);

            // Build question elements
            const questionElements = assignment.questions.map((q, index) => {
                const userAnswerIndex = isCompleted ? submission.answers[index] : null;
                const optionElements = q.options.map((option, optionIndex) => {
                    const input = el('input', { type: 'radio', name: `question-${index}`, value: optionIndex, class: 'mr-3 h-5 w-5 text-red-800 focus:ring-red-500' });
                    if (userAnswerIndex === optionIndex) input.checked = true;
                    if (isCompleted) input.disabled = true;
                    return el('div', {}, [
                        el('label', { class: 'flex items-center p-3 border rounded-lg hover:bg-slate-100 cursor-pointer' }, [
                            input,
                            el('span', { class: 'font-medium', textContent: option })
                        ])
                    ]);
                });
                return el('div', { class: 'mb-8' }, [
                    el('p', { class: 'font-semibold text-lg', textContent: `${index + 1}. ${q.questionText}` }),
                    el('div', { class: 'mt-4 space-y-2' }, optionElements)
                ]);
            });

            // Build submit button
            let submitButton;
            if (isCompleted) {
                submitButton = el('button', { id: 'review-submission-btn', type: 'button', class: 'mt-8 w-full btn-secondary py-3 text-base font-bold', textContent: '審閱課卷' });
            } else {
                submitButton = el('button', { type: 'submit', class: 'mt-8 w-full btn-primary py-3 text-base font-bold btn-seal', textContent: '繳交課卷' });
            }

            // Build back button
            const backButton = el('button', { id: 'back-to-grid-btn', class: 'absolute top-6 left-6 btn-secondary py-2 px-4 text-sm flex items-center gap-2' }, [
                el('svg', { xmlns: "http://www.w3.org/2000/svg", width: "16", height: "16", fill: "currentColor", viewBox: "0 0 16 16" }, [
                    el('path', { 'fill-rule': "evenodd", d: "M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8z" })
                ]),
                '返回'
            ]);

            // Assemble the view
            const quizForm = el('form', { id: 'quiz-form' }, [
                el('h2', { class: 'text-2xl font-bold py-4 mb-4', textContent: '閱讀試煉' }),
                ...questionElements,
                submitButton
            ]);

            const timerDisplay = el('div', { id: 'quiz-timer-display', class: 'text-lg font-semibold text-gray-700 bg-gray-100 px-4 py-2 rounded-lg' }, '00:00');
            const topRightContainer = el('div', { class: 'absolute top-6 right-6 flex gap-2 items-center' });

            if (appState.currentUser.type === 'teacher') {
                const teacherActions = [
                    el('button', {
                        class: 'edit-article-btn btn-secondary py-2 px-4 text-sm',
                        'data-assignment-id': assignment.id,
                        textContent: '潤飾'
                    }),
                    el('button', {
                        class: 'delete-article-btn btn-danger py-2 px-4 text-sm',
                        'data-assignment-id': assignment.id,
                        textContent: '刪除'
                    })
                ];
                teacherActions.forEach(btn => topRightContainer.appendChild(btn));
            }
            
            topRightContainer.appendChild(timerDisplay);

            const hasAnalysis = assignment.analysis && (assignment.analysis.mindmap || assignment.analysis.explanation || assignment.analysis.resources);

            // --- Tab Interface ---
            const articleTab = el('button', { 'data-tab': 'article', class: 'content-tab tab-btn active', textContent: '文章' });
            const analysisTab = el('button', { 'data-tab': 'analysis', class: 'content-tab tab-btn', textContent: '解析' });
            if (!isCompleted || !hasAnalysis) {
                analysisTab.disabled = true;
                analysisTab.title = "完成作答後即可查看";
            }
            const tabContainer = el('div', { class: 'border-b-2 border-gray-200 mb-6 flex space-x-1' }, [articleTab, analysisTab]);

            // --- Content Panels ---
            const articleBody = el('div', { id: 'article-body', class: 'prose-custom content-panel', innerHTML: markdownToHtml(assignment.article) });
            const analysisBody = el('div', { id: 'analysis-body', class: 'prose-custom content-panel hidden' });
            if (hasAnalysis) {
                renderAnalysisContent(analysisBody, assignment.analysis);
            }
            
            const mainContent = el('div', { class: 'p-6 relative' }, [
                backButton,
                topRightContainer,
                el('div', { class: 'mt-16 grid grid-cols-1 lg:grid-cols-3 lg:gap-8' }, [
                    el('div', { class: 'lg:col-span-2' }, [
                        el('article', {}, [
                            el('h1', { class: 'text-3xl font-bold mb-2', textContent: assignment.title }),
                            tagContainer,
                            tabContainer, // Add tabs here
                            articleBody,
                            analysisBody
                        ])
                    ]),
                    el('div', { class: 'lg:col-span-1 mt-8 lg:mt-0' }, [
                        el('div', { class: 'lg:sticky lg:top-8' }, [
                            el('div', { class: 'lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto custom-scrollbar p-1' }, [quizForm])
                        ])
                    ])
                ])
            ]);

            contentDisplay.appendChild(mainContent);
            
            let mindmapRendered = false;
            
            // Render Mermaid diagrams in the article body now that it's in the DOM
            renderAllMermaidDiagrams(contentDisplay.querySelector('#article-body'));

            showArticleContent();
            loadAndApplyHighlights(assignment.id);

            // --- Event Listeners ---
            backButton.addEventListener('click', () => {
                stopQuizTimer();
                showArticleGrid();
            });
            articleBody.addEventListener('mouseup', handleTextSelection);
            articleBody.addEventListener('touchend', handleTextSelection);
            
            tabContainer.addEventListener('click', (e) => {
                const targetTab = e.target.closest('.tab-btn');
                if (!targetTab || targetTab.disabled) return;

                const tabName = targetTab.dataset.tab;

                // Update tab styles
                tabContainer.querySelectorAll('.tab-btn').forEach(tab => tab.classList.remove('active'));
                targetTab.classList.add('active');

                // Update content visibility
                contentDisplay.querySelectorAll('.content-panel').forEach(panel => panel.classList.add('hidden'));
                const targetPanel = contentDisplay.querySelector(`#${tabName}-body`);
                if(targetPanel) targetPanel.classList.remove('hidden');

               // Render mermaid in analysis tab using the new centralized function
               if (tabName === 'analysis' && !mindmapRendered && hasAnalysis) {
                   renderAllMermaidDiagrams(contentDisplay.querySelector('#analysis-body'));
                   mindmapRendered = true;
               }
            });

            if (isCompleted) {
                submitButton.addEventListener('click', () => {
                    if (submission) displayResults(submission.score, assignment, submission.answers);
                });
            } else {
                quizForm.addEventListener('submit', (e) => {
                    e.preventDefault();
                    submitQuiz(assignment);
                });
            }
            if (isCompleted) {
                stopQuizTimer(); // Ensure no timers are running
                const timerDisplay = document.getElementById('quiz-timer-display');
                if (timerDisplay && submission.durationSeconds) {
                    timerDisplay.textContent = formatTime(submission.durationSeconds);
                }
            } else {
                startQuizTimer();
            }
        }

        async function renderAllMermaidDiagrams(container) {
            try {
                // Ensure Mermaid is initialized only once with our theme
                if (!mermaidInitialized) {
                    const elegantTheme = {
                        background: '#FFFFFF', // White background for the chart area
                        fontFamily: "'GenWanNeoSCjk', 'Noto Sans TC', sans-serif",
                        fontSize: '16px',
                        // Node Styles
                        primaryColor: '#F3F4F6', // Light gray background for nodes
                        primaryBorderColor: '#D1D5DB', // Slightly darker border
                        primaryTextColor: '#111827', // Dark text for contrast
                        // Edge (Line) Styles
                        lineColor: '#6B7280', // Medium gray for lines
                        nodeTextColor: '#111827', // Ensure text on nodes is dark
                    };
                    window.mermaid.initialize({
                        startOnLoad: false,
                        theme: 'base',
                        themeVariables: elegantTheme
                    });
                    mermaidInitialized = true;
                }
                
                const mermaidElements = container.querySelectorAll('.mermaid');
                if (mermaidElements.length > 0) {
                     // Use mermaid.run() which is the modern replacement for render
                    await window.mermaid.run({
                        nodes: mermaidElements,
                    });
                    console.log(`Successfully rendered ${mermaidElements.length} Mermaid diagram(s) in the specified container.`);
                }
            } catch (err) {
                console.error("Error rendering Mermaid diagram:", err);
                // Gracefully handle failure by showing an error message in place of the diagram
                container.querySelectorAll('.mermaid').forEach(el => {
                    // Check if it hasn't been processed to avoid replacing already rendered charts or valid error messages
                    if (!el.getAttribute('data-processed')) {
                        el.innerHTML = '<div class="p-4 bg-red-100 border-l-4 border-red-500 text-red-700"><p class="font-bold">圖表渲染失敗</p><p>圖表語法可能有誤。</p></div>';
                    }
                });
            }
        }

        async function submitQuiz(assignment) {
            stopQuizTimer(true); // Stop timer but preserve final time on display
            const formData = new FormData(document.getElementById('quiz-form'));
            let score = 0;
            const userAnswers = [];
            assignment.questions.forEach((q, index) => {
                const userAnswer = formData.get(`question-${index}`);
                userAnswers.push(userAnswer !== null ? parseInt(userAnswer) : null);
                if (userAnswer !== null && parseInt(userAnswer) === q.correctAnswerIndex) score++;
            });
            const finalScore = Math.round((score / assignment.questions.length) * 100);
            const isOverdue = assignment.deadline && new Date() > assignment.deadline.toDate();
            
            // Create submission object (removed isTeacher property)
            const submission = {
                studentId: appState.currentUser.studentId,
                name: appState.currentUser.name,
                classId: appState.currentUser.classId,
                className: appState.currentUser.className,
                assignmentId: assignment.id,
                assignmentTitle: assignment.title,
                answers: userAnswers,
                score: finalScore,
                submittedAt: Timestamp.now(),
                isOverdue: !!isOverdue,
                durationSeconds: appState.quizTimer.elapsedSeconds || 0
            };
            await setDoc(doc(db, "submissions", `${appState.currentUser.studentId}_${assignment.id}`), submission);
            
            // Update local state to reflect the new submission
            const newSubmission = { ...submission, id: `${appState.currentUser.studentId}_${assignment.id}` };
            const existingIndex = appState.allSubmissions.findIndex(s => s.id === newSubmission.id);
            if (existingIndex > -1) {
                appState.allSubmissions[existingIndex] = newSubmission;
            } else {
                appState.allSubmissions.push(newSubmission);
            }

            // Re-render the view to show updated status
            fetchAssignmentsPage(true);

            displayResults(finalScore, assignment, userAnswers);
            
            // Enable the analysis tab
            const analysisTab = document.querySelector('.content-tab[data-tab="analysis"]');
            if (analysisTab) {
                analysisTab.disabled = false;
                analysisTab.title = "查看解析";
            }
            
            // --- Upsert Student Stats and Check Achievements ---
            try {
                const studentRef = doc(db, `classes/${appState.currentUser.classId}/students`, appState.currentUser.studentId);
                const studentSnap = await getDoc(studentRef);
                let finalStudentData;

                if (studentSnap.exists()) {
                    const studentData = studentSnap.data();
                    const updates = {
                        submissionCount: (studentData.submissionCount || 0) + 1,
                        highScoreStreak: (finalScore >= 90) ? (studentData.highScoreStreak || 0) + 1 : 0,
                        tagReadCounts: { ...studentData.tagReadCounts }
                    };

                    const tags = assignment.tags || {};
                    if (tags.contentType) {
                        const key = `contentType_${tags.contentType.trim()}`;
                        updates.tagReadCounts[key] = (updates.tagReadCounts[key] || 0) + 1;
                    }
                    if (tags.difficulty) {
                        const key = `difficulty_${tags.difficulty.trim()}`;
                        updates.tagReadCounts[key] = (updates.tagReadCounts[key] || 0) + 1;
                    }
                    
                    await updateDoc(studentRef, updates);
                    finalStudentData = { ...studentData, ...updates };
                } else {
                    const tags = assignment.tags || {};
                    const tagCounts = {};
                    if (tags.contentType) tagCounts[`contentType_${tags.contentType.trim()}`] = 1;
                    if (tags.difficulty) tagCounts[`difficulty_${tags.difficulty.trim()}`] = 1;

                    finalStudentData = {
                        name: appState.currentUser.name,
                        studentId: appState.currentUser.studentId,
                        submissionCount: 1,
                        highScoreStreak: (finalScore >= 90) ? 1 : 0,
                        tagReadCounts: tagCounts,
                        achievements: [],
                        lastLogin: Timestamp.now()
                    };
                    await setDoc(studentRef, finalStudentData);
                }

                // Crucially, update the local state with the definitive final data
                Object.assign(appState.currentUser, finalStudentData);
                
                // Now, with the updated local state, check for achievements
                await checkAndAwardAchievements(appState.currentUser.studentId, 'submit', appState.currentUser, { submissions: appState.allSubmissions });

            } catch (error) {
                console.error("Failed to update student stats or check achievements:", error);
            }
        }

        function displayResults(score, assignment, userAnswers) {
            appState.currentAssignment = assignment; // Ensure current assignment is set for the modal
            renderModal('result', { score, assignment, userAnswers });
        }

        // --- Analysis View ---




        async function renderArticleAnalysisModal(assignmentId) {
            if (!assignmentId) return;

            const article = appState.assignments.find(a => a.id === assignmentId);
            if (!article) return;

            const selectedClassId = document.getElementById('class-selector')?.value;
            if (!selectedClassId) {
                renderModal('message', { type: 'info', title: '提示', message: '請先從上方的下拉選單選擇一個學堂，才能查看分析報告。' });
                return;
            }
            
            showLoading('正在載入分析報告...');
            try {
                // **FIX**: Force-load submissions for the selected class and assignment to ensure data is fresh.
                const submissionsQuery = query(
                    collection(db, "submissions"),
                    where("classId", "==", selectedClassId),
                    where("assignmentId", "==", assignmentId)
                );
                const submissionsSnapshot = await getDocs(submissionsQuery);
                const newSubmissions = submissionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Merge new submissions into the global state, avoiding duplicates.
                const existingSubmissionIds = new Set(appState.allSubmissions.map(s => s.id));
                newSubmissions.forEach(sub => {
                    if (!existingSubmissionIds.has(sub.id)) {
                        appState.allSubmissions.push(sub);
                    }
                });

                const students = await loadStudentsForClass(selectedClassId);
                if (students === null) { // Check for null in case of error
                    renderModal('message', { type: 'error', title: '錯誤', message: '載入學生資料失敗。' });
                    return;
                }
                 if (students.length === 0) {
                    renderModal('message', { type: 'info', title: '提示', message: '此學堂尚無學子名冊。' });
                    return;
                }

                const tableHeader = `<tr class="bg-slate-100"><th class="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase">座號</th><th class="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase">姓名</th><th class="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase">狀態</th><th class="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase">分數</th><th class="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase">作答時間</th><th class="px-6 py-3 text-left text-xs font-bold text-slate-600 uppercase">行事</th></tr>`;
                const tableBody = students.sort((a, b) => a.seatNumber - b.seatNumber).map(student => {
                    const submission = appState.allSubmissions.find(s => s.assignmentId === assignmentId && s.studentId === student.id);
                    let status, score, detailBtn, duration;
                    if (submission) {
                        const submissionTime = formatSubmissionTime(submission.submittedAt);
                        status = submission.isOverdue ? `<span class="font-semibold text-orange-500">逾期完成</span><span class="text-xs text-slate-500 ml-2">${submissionTime}</span>` : `<span class="font-semibold text-green-600">已完成</span><span class="text-xs text-slate-500 ml-2">${submissionTime}</span>`;
                        score = `<span class="font-bold">${submission.score}%</span>`;
                        duration = formatTime(submission.durationSeconds || 0);
                        detailBtn = `<button data-assignment-id="${assignmentId}" data-student-id="${student.id}" class="view-submission-review-btn text-red-700 hover:text-red-900 font-semibold">查看詳情</button>`;
                        
                        // Add a warning for suspected guessing
                        if (submission.durationSeconds < 60 && submission.score < 60) {
                            status += ` <span class="text-red-500" title="作答時間過短且分數較低，可能為猜測作答。">⚠️</span>`;
                        }
                    } else {
                        status = `<span class="font-semibold text-red-500">未應試</span>`;
                        score = '-';
                        duration = '-';
                        detailBtn = '';
                    }
                    return `<tr><td class="px-6 py-4">${student.seatNumber}</td><td class="px-6 py-4">${student.name}</td><td class="px-6 py-4">${status}</td><td class="px-6 py-4">${score}</td><td class="px-6 py-4">${duration}</td><td class="px-6 py-4">${detailBtn}</td></tr>`;
                }).join('');

                const tableHtml = `<table class="min-w-full bg-white border border-slate-200 rounded-lg"><thead>${tableHeader}</thead><tbody class="divide-y divide-slate-200">${tableBody}</tbody></table>`;

                renderModal('articleAnalysis', {
                    title: `〈${escapeHtml(article.title)}〉 分析報告`,
                    contentHtml: tableHtml,
                    assignmentId: assignmentId
                });
            } catch (error) {
                console.error("渲染課業分析報告時發生錯誤:", error);
                renderModal('message', { type: 'error', title: '錯誤', message: '載入分析報告失敗。' });
            } finally {
                hideLoading();
            }
        }

        function openEditModal(assignment) {
            renderModal('editArticle', { assignment });
        }

        async function handleSaveEdit(e) {
            const assignmentId = e.target.dataset.assignmentId;
            if (!assignmentId) return;

            const modal = dom.modalContainer.querySelector('.modal-instance');
            if (!modal) return;

            const errorEl = modal.querySelector('#edit-article-error');
            if (errorEl) errorEl.textContent = '';

            // Read all data from the DOM first before showing the loader
            const title = modal.querySelector('#edit-title').value;
            const article = modal.querySelector('#edit-article').value;
            const deadlineValue = modal.querySelector('#edit-deadline').value;
            const tags = {
                format: modal.querySelector('#edit-tag-format').value,
                contentType: modal.querySelector('#edit-tag-contentType').value,
                difficulty: modal.querySelector('#edit-tag-difficulty').value
            };

            let allQuestionsValid = true;
            const questionsData = [];
            const questionDivs = modal.querySelectorAll('#edit-questions-container > div[data-question-index]');

            for (const qDiv of questionDivs) {
                const index = qDiv.dataset.questionIndex;
                const checkedRadio = qDiv.querySelector(`input[name="edit-correct-${index}"]:checked`);

                if (!checkedRadio) {
                    if (errorEl) errorEl.textContent = `錯誤：第 ${parseInt(index) + 1} 題尚未設定正確答案。`;
                    allQuestionsValid = false;
                    break;
                }

                const question = {
                    questionText: qDiv.querySelector('.edit-question-text').value,
                    options: Array.from(qDiv.querySelectorAll('.edit-option')).map(opt => opt.value),
                    correctAnswerIndex: parseInt(checkedRadio.value),
                    explanation: qDiv.querySelector('.edit-explanation').value,
                };
                questionsData.push(question);
            }

            if (!allQuestionsValid) {
                return;
            }
            
            showLoading('正在儲存變更...');

            const updatedData = {
                title: title,
                article: article,
                questions: questionsData,
                tags: tags,
                analysis: {
                    mindmap: modal.querySelector('#edit-analysis-mindmap')?.value || "",
                    explanation: modal.querySelector('#edit-analysis-explanation')?.value || "",
                    thinking_questions: modal.querySelector('#edit-analysis-thinking-questions')?.value || ""
                },
                isPublic: modal.querySelector('#edit-is-public').checked
            };
            if (deadlineValue) {
                updatedData.deadline = Timestamp.fromDate(new Date(deadlineValue + "T23:59:59"));
            } else {
                updatedData.deadline = deleteField();
            }
            
            try {
                console.log("Attempting to save data:", JSON.stringify(updatedData, null, 2));
                await updateDoc(doc(db, `assignments`, assignmentId), updatedData);

                // 更新本地 allAssignments 陣列
                if (updatedData.deadline && typeof updatedData.deadline.isEqual === 'function') {
                    // This is a sentinel, don't merge it into the local state literally.
                    // Instead, remove the property from the local object.
                    const localUpdatedData = { ...updatedData };
                    delete localUpdatedData.deadline;
                    
                    const studentIndex = appState.assignments.findIndex(a => a.id === assignmentId);
                    if (studentIndex !== -1) {
                        appState.assignments[studentIndex] = { ...appState.assignments[studentIndex], ...localUpdatedData };
                        delete appState.assignments[studentIndex].deadline;
                    }
                    
                    const teacherIndex = appState.teacherArticleQueryState.articles.findIndex(a => a.id === assignmentId);
                    if (teacherIndex !== -1) {
                        appState.teacherArticleQueryState.articles[teacherIndex] = { ...appState.teacherArticleQueryState.articles[teacherIndex], ...localUpdatedData };
                        delete appState.teacherArticleQueryState.articles[teacherIndex].deadline;
                    }
                } else {
                    const studentIndex = appState.assignments.findIndex(a => a.id === assignmentId);
                    if (studentIndex !== -1) {
                        appState.assignments[studentIndex] = { ...appState.assignments[studentIndex], ...updatedData };
                    }
                    
                    const teacherIndex = appState.teacherArticleQueryState.articles.findIndex(a => a.id === assignmentId);
                    if (teacherIndex !== -1) {
                        appState.teacherArticleQueryState.articles[teacherIndex] = { ...appState.teacherArticleQueryState.articles[teacherIndex], ...updatedData };
                    }
                }
                // FIX: Also update the teacher's article list state
                const teacherIndex = appState.teacherArticleQueryState.articles.findIndex(a => a.id === assignmentId);
                if (teacherIndex !== -1) {
                    appState.teacherArticleQueryState.articles[teacherIndex] = { ...appState.teacherArticleQueryState.articles[teacherIndex], ...updatedData };
                }


                hideLoading();
                closeModal();
                // FIX: Re-render the teacher's article table with the updated data
                renderTeacherArticleTable(appState.teacherArticleQueryState.articles, true);
                renderModal('message', { type: 'success', title: '修訂成功', message: '篇章內容已成功修訂！' });
            } catch (e) {
                const errorEl = modal.querySelector('#edit-article-error');
                hideLoading(); // 在 catch 中也要隱藏 loading
                console.error("Error saving article:", e);
                console.log("Data that failed to save:", JSON.stringify(updatedData, null, 2));
                if (errorEl) errorEl.textContent = '修訂失敗，請按 F12 打開開發者工具，查看 Console 中的詳細錯誤訊息。';
            }
        }

        async function handleAnalysisAI(e) {
            const button = e.target.closest('.edit-analysis-ai-btn');
            const modal = button.closest('.modal-instance');
            const articleText = modal.querySelector('#edit-article').value;
            
            const target = button.dataset.target;
            const action = button.dataset.action;
            
            const textareas = {
                mindmap: modal.querySelector('#edit-analysis-mindmap'),
                explanation: modal.querySelector('#edit-analysis-explanation'),
                thinking_questions: modal.querySelector('#edit-analysis-thinking-questions')
            };
            const targetTextarea = textareas[target];

            if (!articleText) {
                renderModal('message', { type: 'error', title: '錯誤', message: '必須先有文章內容才能生成解析。' });
                return;
            }
            if (!targetTextarea) return;

            const originalContent = targetTextarea.value;

            if (action === 'refine') {
                const refinePrompt = await renderModal('aiAnalysisRefine', {});
                if (refinePrompt === null) return; // User cancelled

                showLoading('AI 書僮正在潤飾中...');
                try {
                    const newContent = await callSingleGeminiAnalysis(articleText, target, 'refine', originalContent, refinePrompt);
                    if (newContent) {
                        targetTextarea.value = newContent;
                    } else {
                        throw new Error("AI 未能回傳有效內容。");
                    }
                } catch (error) {
                    console.error(`AI analysis error for ${target}:`, error);
                    renderModal('message', { type: 'error', title: 'AI 操作失敗', message: `AI 書僮處理時發生錯誤：${error.message}` });
                } finally {
                    hideLoading();
                }
            } else { // regenerate
                showLoading('AI 書僮正在生成中...');
                try {
                    const newContent = await callSingleGeminiAnalysis(articleText, target, 'regenerate', originalContent);
                    if (newContent) {
                        targetTextarea.value = newContent;
                    } else {
                        throw new Error("AI 未能回傳有效內容。");
                    }
                } catch (error) {
                    console.error(`AI analysis error for ${target}:`, error);
                    renderModal('message', { type: 'error', title: 'AI 操作失敗', message: `AI 書僮處理時發生錯誤：${error.message}` });
                } finally {
                    hideLoading();
                }
            }
        }


        async function displayStudentAnalysis(studentId, classId) {
            await renderModal('studentAnalysis');
            const contentEl = document.getElementById('student-analysis-content');
            const titleEl = document.getElementById('student-analysis-title');
            if (!contentEl || !titleEl) return;

            contentEl.innerHTML = '<div class="text-center p-8"><div class="loader"></div><p class="mt-4">讀取學子紀錄中...</p></div>';

            try {
                let student = null;
                let userName = '';
                const isCurrentUserStudent = appState.currentUser.type === 'student' && studentId === appState.currentUser.studentId;
                const isViewingSelfAsTeacher = appState.currentUser.type === 'teacher' && studentId === 'teacher_user';

                if (isCurrentUserStudent || isViewingSelfAsTeacher) {
                    userName = appState.currentUser.name;
                } else if (classId) {
                    const studentDoc = await getDoc(doc(db, `classes/${classId}/students`, studentId));
                    if (studentDoc.exists()) {
                        student = { id: studentDoc.id, ...studentDoc.data() };
                        userName = student.name;
                    }
                }

                if (!userName) throw new Error(`無法找到 ID 為 ${studentId} 的使用者資訊。`);
                
                titleEl.textContent = `${userName} 的個人課業`;

                const submissionsQuery = query(collection(db, "submissions"), where("studentId", "==", studentId));
                const submissionsSnapshot = await getDocs(submissionsQuery);
                const studentSubmissions = submissionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                const canChangePassword = isCurrentUserStudent || isViewingSelfAsTeacher;
                const changePasswordBtn = canChangePassword ? `<button id="change-password-btn" class="w-full btn-secondary py-3 mb-6 font-bold">修訂憑信</button>` : '';

                if (studentSubmissions.length === 0) {
                    contentEl.innerHTML = `<div class="p-8">${changePasswordBtn}<p class="text-center text-slate-500">此學子尚未有任何課業記錄。</p></div>`;
                } else {
                    const completedCount = studentSubmissions.length;
                    const totalScore = studentSubmissions.reduce((sum, s) => sum + s.score, 0);
                    const avgScore = completedCount > 0 ? totalScore / completedCount : 0;
                    
                    // Note: Completion rate logic depends on appState.assignments which might be stale.
                    // For now, we'll calculate based on what's loaded.
                    // To calculate completion rate correctly, we need ALL assignments, not just the paginated ones.
                    const allAssignmentsSnapshot = await getDocs(collection(db, "assignments"));
                    const allAssignments = allAssignmentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                    const now = new Date();
                    const dueAssignments = allAssignments.filter(a => a.deadline && a.deadline.toDate() < now);
                    const completedDueAssignmentIds = new Set(studentSubmissions.filter(s => dueAssignments.some(a => a.id === s.assignmentId)).map(s => s.assignmentId));
                    const completionRate = dueAssignments.length > 0 ? (completedDueAssignmentIds.size / dueAssignments.length) * 100 : 100; // If no assignments are due, completion is 100%

                    // --- Weekly Score Chart Logic ---
                    const weeklyData = {};

                    studentSubmissions.forEach(sub => {
                        if (!sub.submittedAt) return;
                        const date = sub.submittedAt.toDate();
                        const startOfWeek = getStartOfWeek(date).toISOString().split('T')[0];
                        if (!weeklyData[startOfWeek]) {
                            weeklyData[startOfWeek] = { scores: [], count: 0 };
                        }
                        weeklyData[startOfWeek].scores.push(sub.score);
                        weeklyData[startOfWeek].count++;
                    });

                    const sortedWeeks = Object.keys(weeklyData).sort();
                    const chartLabels = sortedWeeks.map(week => {
                        const startDate = new Date(week);
                        const endDate = new Date(startDate);
                        endDate.setDate(startDate.getDate() + 6);
                        const format = (d) => `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
                        return `${format(startDate)}~${format(endDate)}`;
                    });
                    
                    const scoreData = sortedWeeks.map(week => {
                        const { scores } = weeklyData[week];
                        const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
                        return avg.toFixed(0);
                    });
                    const completionData = sortedWeeks.map(week => weeklyData[week].count || 0);

                    const chartHtml = sortedWeeks.length > 1 ? `
                        <h3 class="font-bold text-lg mb-2">每週學習趨勢分析</h3>
                        <div class="p-4 bg-white rounded-lg shadow">
                            <canvas id="weekly-score-chart"></canvas>
                        </div>
                    ` : '<div class="p-4 bg-white rounded-lg shadow text-center text-slate-500">尚無足夠資料可繪製學習趨勢圖，完成兩週以上的課業後將會顯示。</div>';

                    contentEl.innerHTML = `
                        <div class="p-2">
                            ${changePasswordBtn}
                            <button id="ai-student-analysis-btn" data-student-id="${studentId}" class="w-full btn-teal py-3 mb-6 font-bold">啟動 AI 提供個人策勵</button>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                                <div class="p-4 bg-white rounded-lg text-center shadow"><div class="text-sm text-gray-500">平均得分</div><div class="text-3xl font-bold text-gray-700">${avgScore.toFixed(1)}</div></div>
                                <div class="p-4 bg-white rounded-lg text-center shadow"><div class="text-sm text-gray-500">完成篇數</div><div class="text-3xl font-bold text-gray-700">${completedCount}</div></div>
                                <div class="p-4 bg-white rounded-lg text-center shadow"><div class="text-sm text-gray-500">課業完成率</div><div class="text-3xl font-bold text-gray-700">${completionRate.toFixed(0)}%</div></div>
                            </div>
                            ${chartHtml}
                        </div>`;
                    
                    if (sortedWeeks.length > 1) {
                        setTimeout(() => {
                            const ctx = document.getElementById('weekly-score-chart')?.getContext('2d');
                            if (ctx) {
                                new Chart(ctx, {
                                    type: 'bar',
                                    data: {
                                        labels: chartLabels,
                                        datasets: [{
                                            label: '每週完成篇數',
                                            data: completionData,
                                            backgroundColor: 'rgba(255, 159, 64, 0.5)',
                                            borderColor: 'rgba(255, 159, 64, 1)',
                                            yAxisID: 'y1',
                                            order: 2
                                        }, {
                                            type: 'line',
                                            label: '每週平均分數',
                                            data: scoreData,
                                            fill: true,
                                            backgroundColor: 'rgba(75, 192, 192, 0.2)',
                                            borderColor: 'rgba(75, 192, 192, 1)',
                                            tension: 0.1,
                                            yAxisID: 'y',
                                            order: 1
                                        }]
                                    },
                                    options: {
                                        responsive: true,
                                        interaction: {
                                            mode: 'index',
                                            intersect: false,
                                        },
                                        scales: {
                                            y: {
                                                type: 'linear',
                                                display: true,
                                                position: 'left',
                                                beginAtZero: true,
                                                max: 100,
                                                title: {
                                                    display: true,
                                                    text: '平均分數'
                                                }
                                            },
                                            y1: {
                                                type: 'linear',
                                                display: true,
                                                position: 'right',
                                                beginAtZero: true,
                                                title: {
                                                    display: true,
                                                    text: '完成篇數'
                                                },
                                                grid: {
                                                    drawOnChartArea: false,
                                                },
                                                ticks: {
                                                    stepSize: 1
                                                }
                                            }
                                        }
                                    }
                                });
                            }
                        }, 100);
                    }
                }
                
                // Re-attach event listeners inside the modal
                if (canChangePassword) {
                    const pwBtn = contentEl.querySelector('#change-password-btn');
                    if(pwBtn) pwBtn.addEventListener('click', () => renderModal('changePassword'));
                }
                contentEl.querySelectorAll('.view-submission-review-btn').forEach(btn => btn.addEventListener('click', e => {
                    const { assignmentId, studentId } = e.currentTarget.dataset;
                    displaySubmissionReview(assignmentId, studentId);
                }));
                const aiBtn = contentEl.querySelector('#ai-student-analysis-btn');
                if(aiBtn) aiBtn.addEventListener('click', e => handleStudentAiAnalysis(e.currentTarget.dataset.studentId));

            } catch (error) {
                console.error("Error displaying student analysis:", error);
                contentEl.innerHTML = `<p class="text-red-500 p-8">讀取學子紀錄失敗：${error.message}</p>`;
            }
        }

        function displaySubmissionReview(assignmentId, studentId) {
            const submission = appState.allSubmissions.find(s => s.assignmentId === assignmentId && s.studentId === studentId);
            const assignment = appState.assignments.find(a => a.id === assignmentId);
            if (!submission || !assignment) { renderModal('message', { type: 'error', title: '錯誤', message: '找不到作答記錄。' }); return; }
            
            renderModal('studentDetail');
            setTimeout(() => {
                let userName = submission?.name || '使用者';
                document.getElementById('student-detail-title').textContent = `${userName}《${assignment.title}》作答詳情`;
                document.getElementById('student-detail-content').innerHTML = assignment.questions.map((q, i) => {
                    const userAnswerIndex = submission.answers[i];
                    const correctAnswerIndex = q.correctAnswerIndex;
                    const isCorrect = userAnswerIndex === correctAnswerIndex;
                    return `<div class="p-4 rounded-lg mb-3 ${isCorrect ? 'bg-green-100' : 'bg-red-100'}"><p class="font-semibold text-gray-800">第 ${i+1} 題: ${q.questionText}</p><p class="mt-2 text-sm">你的選擇: <span class="font-medium">${userAnswerIndex !== null ? q.options[userAnswerIndex] : '未作答'}</span></p><p class="mt-1 text-sm">正確答案: <span class="font-medium">${q.options[correctAnswerIndex]}</span></p><div class="mt-3 pt-3 border-t border-gray-200"><p class="font-semibold text-red-800">【淺解】</p><p class="text-gray-600 text-sm mt-1">${q.explanation || '暫無淺解。'}</p></div></div>`;
                }).join('');
            }, 0);
        }

        async function handleStudentAiAnalysis(studentId) {
            const studentSubmissions = appState.allSubmissions.filter(s => s.studentId === studentId);
            if (studentSubmissions.length < 1) { renderModal('message', { type: 'info', title: '提示', message: '該學子至少需要一筆課業記錄才能進行分析。' }); return; }
            showLoading('AI 書僮正在分析學習數據...');
            const avgScore = studentSubmissions.reduce((sum, s) => sum + s.score, 0) / studentSubmissions.length;
            
            // 為了準確計算完成率，需要讀取所有作業，而不是依賴可能不完整的 appState
            const allAssignmentsSnapshot = await getDocs(collection(db, "assignments"));
            const allAssignments = allAssignmentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            const now = new Date();
            const dueAssignments = allAssignments.filter(a => a.deadline && a.deadline.toDate() < now);
            const completedDueAssignmentIds = new Set(studentSubmissions.filter(s => dueAssignments.some(a => a.id === s.assignmentId)).map(s => s.assignmentId));
            const completionRate = dueAssignments.length > 0 ? (completedDueAssignmentIds.size / dueAssignments.length) * 100 : 100; // If no assignments are due, completion is 100%

            const pisaStats = { level1: { total: 0, correct: 0 }, level2: { total: 0, correct: 0 }, level3: { total: 0, correct: 0 } };
            studentSubmissions.forEach(sub => {
                const assignment = allAssignments.find(a => a.id === sub.assignmentId);
                if (assignment) {
                    assignment.questions.forEach((q, index) => {
                        const isCorrect = sub.answers[index] === q.correctAnswerIndex;
                        if (index === 0) { pisaStats.level1.total++; if (isCorrect) pisaStats.level1.correct++; } 
                        else if (index === 1 || index === 2) { pisaStats.level2.total++; if (isCorrect) pisaStats.level2.correct++; }
                        else if (index === 3 || index === 4) { pisaStats.level3.total++; if (isCorrect) pisaStats.level3.correct++; }
                    });
                }
            });
            const pisa1_accuracy = pisaStats.level1.total > 0 ? (pisaStats.level1.correct / pisaStats.level1.total) * 100 : -1;
            const pisa2_accuracy = pisaStats.level2.total > 0 ? (pisaStats.level2.correct / pisaStats.level2.total) * 100 : -1;
            const pisa3_accuracy = pisaStats.level3.total > 0 ? (pisaStats.level3.correct / pisaStats.level3.total) * 100 : -1;
            const prompt = `身為一位循循善誘的書院夫子，請根據學子的閱讀試煉數據，提供一份**簡潔、易懂、具體**的個人策勵。
請注意：
1.  **全文不超過 250 字**。
2.  語氣要親切、鼓勵，適合學子閱讀。
3.  直接點出可以精進的部分，並提供一個具體的練習方向。
4.  請用 Markdown 格式化你的回覆，可以使用粗體字來強調重點。
### 學子課業數據
- **平均得分**：${avgScore.toFixed(1)}分
- **課業完成率**：${completionRate.toFixed(0)}%
- **PISA 層次答對率**：
  - **擷取與檢索**：${pisa1_accuracy === -1 ? '無數據' : pisa1_accuracy.toFixed(0) + '%'}
  - **統整與解釋**：${pisa2_accuracy === -1 ? '無數據' : pisa2_accuracy.toFixed(0) + '%'}
  - **省思與評鑑**：${pisa3_accuracy === -1 ? '無數據' : pisa3_accuracy.toFixed(0) + '%'}
`;
            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!response.ok) throw new Error(`API 請求失敗`);
                const result = await response.json();
                if (result.candidates?.length > 0) {
                    const analysisText = result.candidates[0].content.parts[0].text;
                    renderModal('aiStudentSuggestion', { suggestionText: analysisText });
                } else { throw new Error("API 未返回有效分析。"); }
            } catch (error) { console.error("AI 學生分析失敗:", error); renderModal('message', { type: 'error', title: '分析失敗', message: 'AI 分析失敗，請稍後再試。' }); } 
            finally { hideLoading(); }
        }

        async function handleAiRewrite() {
            const command = document.getElementById('ai-rewrite-command').value;
            const articleText = document.getElementById('edit-article')?.value;

            if (!command || !articleText) {
                renderModal('message', { type: 'error', title: '操作錯誤', message: '請確保編輯區有文章內容，並已輸入改寫指令。' });
                return;
            }
            
            showLoading('AI 書僮正在改寫文章...');
            
            const prompt = `請根據以下指令，潤飾這篇文稿。\n請嚴格遵守以下格式要求：\n1.  **輸出格式**：請只輸出潤飾後的文稿全文，不要包含任何額外的說明或標題。\n2.  **段落縮排**：所有文字段落（包含第一段）的開頭都必須加上兩個全形空格「　　」來進行縮排。\n\n指令："""${command}"""\n原文："""${articleText}"""`;
            
            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                
                if (!response.ok) {
                    throw new Error(`API 請求失敗: ${response.status} ${response.statusText}`);
                }
                
                const result = await response.json();
                
                if (result.candidates?.length > 0 && result.candidates[0].content.parts[0].text) {
                    const newArticle = result.candidates[0].content.parts[0].text;
                    const editArticleEl = document.getElementById('edit-article');
                    if (editArticleEl) {
                        editArticleEl.value = newArticle;
                    }
                    closeTopModal();
                } else {
                    throw new Error("API 未返回有效內容或內容為空。");
                }
            } catch (error) {
                console.error("AI Rewrite Error:", error);
                renderModal('message', { type: 'error', title: '潤飾失敗', message: `操作失敗，請稍後再試。(${error.message})` });
            } finally {
                hideLoading();
            }
        }

        async function handleRegenerateQuestions(assignmentId, questionIndex = null) {
            const articleText = document.getElementById('edit-article').value;
            if (!articleText) { renderModal('message', { type: 'error', title: '操作錯誤', message: '文章內容不可為空。' }); return; }
            const isSingle = questionIndex !== null;
            showLoading(isSingle ? `正在重新生成第 ${parseInt(questionIndex)+1} 題...` : '正在重新生成所有試題...');
            const pisaLevels = ["擷取與檢索", "統整與解釋", "統整與解釋", "省思與評鑑", "省思與評鑑"];
            const prompt = `你是一位學養深厚的書院夫子，請根據以下文稿，為門下學子重新設計一份高品質的素養導向閱讀試煉。\n文稿："""${articleText}"""\n請遵循以下專業要求：\n1.  **試題設計**：${isSingle ? `請只設計 1 道單選題，且試題必須符合 PISA 閱讀素養的「${pisaLevels[questionIndex]}」層次。` : `請設計 5 道單選題，並依序符合 PISA 閱讀素養的三個層次：第1題(擷取與檢索)、第2-3題(統整與解釋)、第4-5題(省思與評鑑)。`}\n2. **產出格式**：每題都需要包含題幹（questionText）、4 個選項（options）、正確答案索引值（correctAnswerIndex, 0-3）、以及**詳盡的淺解**（explanation）。請嚴格按照指定的 JSON 格式輸出，你的回覆必須是一個 JSON 物件，其 key 為 "${isSingle ? 'question' : 'questions'}"。`;
            const singleQuestionSchema = {type:"OBJECT",properties:{questionText:{type:"STRING"},options:{type:"ARRAY",items:{type:"STRING"}},correctAnswerIndex:{type:"NUMBER"},explanation:{type:"STRING"}},required:["questionText","options","correctAnswerIndex","explanation"]};
            const multipleQuestionsSchema = {type:"ARRAY", items: singleQuestionSchema};
            const finalSchema = { type: "OBJECT", properties: { [isSingle ? "question" : "questions"]: isSingle ? singleQuestionSchema : multipleQuestionsSchema }, required: [isSingle ? "question" : "questions"] };
            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseSchema: finalSchema } };
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (!response.ok) throw new Error(`API 請求失敗: ${response.statusText}`);
                const result = await response.json();
                if (result.candidates?.length > 0) {
                    const content = JSON.parse(result.candidates[0].content.parts[0].text);
                    if (isSingle) {
                        const newQuestion = content.question;
                        const qDiv = document.querySelector(`#edit-questions-container > div[data-question-index="${questionIndex}"]`);
                        if (qDiv) {
                            qDiv.querySelector('.edit-question-text').value = newQuestion.questionText;
                            const optionInputs = qDiv.querySelectorAll('.edit-option');
                            newQuestion.options.forEach((opt, i) => optionInputs[i].value = opt);
                            qDiv.querySelector(`input[name="edit-correct-${questionIndex}"][value="${newQuestion.correctAnswerIndex}"]`).checked = true;
                            qDiv.querySelector('.edit-explanation').value = newQuestion.explanation;
                        }
                    } else {
                        const newQuestions = content.questions;
                        const container = document.getElementById('edit-questions-container');
                        if(container) {
                            container.innerHTML = newQuestions.map((q, index) => `<div class="p-4 bg-white rounded-lg border" data-question-index="${index}"><div class="flex justify-between items-center mb-2"><label class="font-semibold">第 ${index + 1} 題</label><button data-question-index="${index}" class="regenerate-question-btn btn-secondary py-1 px-3 text-xs">重新出題</button></div><textarea class="edit-question-text w-full input-styled mt-1" rows="2">${escapeHtml(q.questionText)}</textarea><div class="mt-2 space-y-2">${q.options.map((opt, optIndex) => `<div class="flex items-center gap-2"><input type="radio" name="edit-correct-${index}" value="${optIndex}" ${q.correctAnswerIndex === optIndex ? 'checked' : ''}><input type="text" class="edit-option w-full input-styled" value="${escapeHtml(opt)}"></div>`).join('')}</div><label class="font-semibold mt-2 block">詳解</label><textarea class="edit-explanation w-full input-styled mt-1" rows="2">${escapeHtml(q.explanation)}</textarea></div>`).join('');
                            container.querySelectorAll('.regenerate-question-btn').forEach(btn => btn.addEventListener('click', (e) => handleRegenerateQuestions(assignmentId, e.target.dataset.questionIndex)));
                        }
                    }
                } else { throw new Error("API 未返回有效內容。"); }
            } catch (error) { console.error("重新生成試題失敗:", error); renderModal('message', { type: 'error', title: '生成失敗', message: '操作失敗，請稍後再試。' }); }
            finally { hideLoading(); }
        }

        async function handleFormatText() {
            const button = document.getElementById('format-text-btn');
            const textarea = document.getElementById('pasted-article-textarea');
            if (!button || !textarea) return;

            const rawText = textarea.value;
            if (!rawText.trim()) {
                renderModal('message', { title: '提示', message: '請先在文本框中輸入內容。' });
                return;
            }

            const originalButtonText = button.textContent;
            button.disabled = true;
            button.innerHTML = '<div class="loader-sm"></div> 整理中';

            try {
                if (!appState.geminiApiKey) throw new Error("AI API 金鑰未設定。");
                
                const prompt = `你是一位專業且細心的中文文本編輯。你的唯一任務是根據以下規則，清理並優化使用者提供的文本，不做任何內容上的增刪或修改。

# 編輯規則 (必須嚴格遵守):
1.  **段落排版**: 在每一個自然段落的開頭，加上兩個全形空格 "　　" 作為縮排。段落之間空一行。
2.  **標點符號標準化**: 將文本中所有的半形標點符號轉換為對應的全形版本。對照表如下：
    *   \`,\` (逗號) -> \`，\`
    *   \`.\` (句號) -> \`。\`
    *   \`? \` (問號) -> \`？\`
    *   \`!\` (驚嘆號) -> \`！\`
    *   \`:\` (冒號) -> \`：\`
    *   \`;\` (分號) -> \`；\`
    *   \`"\` (引號) -> \`「」\` (請使用標準中文引號)
    *   \`'\` (單引號) -> \`『』\` (請用作書名號或在引號內的引號)
3.  **移除亂碼**: 辨識並徹底移除文本中可能因複製貼上而產生的、無意義的亂碼、數字標示或非預期字元 (例如 Mojibake、控制字元等)。
4.  **保留換行**: 完全保留原文的換行結構。如果原文有多個空行，也請保留。

# 輸出要求:
*   **絕對不要**回覆任何除了整理後文本以外的內容。
*   **不要**有任何開頭的問候語或結尾的說明。
*   你的回覆**必須**是純文字 (plain text)。

# 需要整理的文本如下：
"""
${rawText}
"""`;

                const apiKey = appState.geminiApiKey;
                const payload = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

                if (!response.ok) {
                    throw new Error(`API 請求失敗 (${response.status})`);
                }

                const result = await response.json();
                if (result.candidates && result.candidates.length > 0) {
                    const formattedText = result.candidates[0].content.parts[0].text;
                    textarea.value = formattedText;
                } else {
                    throw new Error("API 未返回有效內容。");
                }

            } catch (error) {
                console.error("文本整理失敗:", error);
                renderModal('message', { type: 'error', title: '整理失敗', message: '操作失敗，請檢查主控台錯誤訊息。' });
            } finally {
                button.disabled = false;
                button.textContent = originalButtonText;
            }
        }

        function handleEditClassName(classId) {
            if (!classId) return;
            const selectedClass = appState.allClasses.find(c => c.id === classId);
            if (!selectedClass) return;
            renderModal('editClassName', { classId, className: selectedClass.className });
        }

        async function handleConfirmEditClassName(classId) {
            const newClassName = document.getElementById('edit-class-name-input').value.trim();
            const errorEl = document.getElementById('edit-class-name-error');
            const originalClass = appState.allClasses.find(c => c.id === classId);
            if (!newClassName) { errorEl.textContent = '名號不可為空。'; return; }
            if (newClassName === originalClass.className) { closeModal(); return; }
            showLoading('正在更新名稱...');
            try {
                await updateDoc(doc(db, "classes", classId), { className: newClassName });
                hideLoading();
                renderModal('message', { type: 'success', title: '更新成功', message: '學堂名號已更新！' });
            } catch (e) { hideLoading(); console.error("更新名稱失敗:", e); errorEl.textContent = '更新失敗。'; }
        }

        async function handleChangePassword() {
            const errorEl = document.getElementById('change-password-error');
            errorEl.textContent = '';
            const currentPassword = document.getElementById('current-password').value;
            const newPassword = document.getElementById('new-password').value;
            const confirmNewPassword = document.getElementById('confirm-new-password').value;

            if (!currentPassword || !newPassword || !confirmNewPassword) {
                errorEl.textContent = '所有欄位皆為必填。';
                return;
            }
            if (newPassword !== confirmNewPassword) {
                errorEl.textContent = '新密語與確認密語不相符。';
                return;
            }
            if (newPassword.length < 4) {
                errorEl.textContent = '新密語長度至少需要四個字元。';
                return;
            }

            showLoading('正在驗證與更新密語...');

            try {
                const currentUser = appState.currentUser;
                if (!currentUser) {
                    throw new Error("User not logged in.");
                }

                // --- Teacher Password Change Logic ---
                if (currentUser.type === 'teacher') {
                    const teacherUserRef = doc(db, "classes/teacher_class/students", "teacher_user");
                    const teacherUserSnap = await getDoc(teacherUserRef);

                    let currentPasswordHash;
                    if (teacherUserSnap.exists() && teacherUserSnap.data().passwordHash) {
                        currentPasswordHash = teacherUserSnap.data().passwordHash;
                    } else {
                        currentPasswordHash = TEACHER_PASSWORD_HASH; // Fallback to hardcoded hash
                    }

                    const enteredCurrentHash = await hashString(currentPassword);
                    if (enteredCurrentHash !== currentPasswordHash) {
                        errorEl.textContent = '舊密語錯誤。';
                        return;
                    }

                    const newPasswordHash = await hashString(newPassword);
                    // Use setDoc with merge to create or update the teacher document safely
                    await setDoc(teacherUserRef, { passwordHash: newPasswordHash }, { merge: true });
                    
                    closeModal();
                    renderModal('message', { title: '成功', message: '憑信已成功修訂。' });

                // --- Student Password Change Logic ---
                } else if (currentUser.type === 'student') {
                    const studentDocRef = doc(db, `classes/${currentUser.classId}/students`, currentUser.studentId);
                    const studentDocSnap = await getDoc(studentDocRef);

                    if (!studentDocSnap.exists()) {
                        errorEl.textContent = '找不到您的學生資料。';
                        return;
                    }

                    const studentDocData = studentDocSnap.data();
                    const selectedClass = appState.allClasses.find(c => c.id === currentUser.classId);
                    const defaultPassword = generateDefaultPassword(selectedClass.className, studentDocData.seatNumber);
                    
                    const currentPasswordHashOnRecord = studentDocData.passwordHash || await hashString(defaultPassword);
                    const enteredCurrentPasswordHash = await hashString(currentPassword);

                    if (enteredCurrentPasswordHash !== currentPasswordHashOnRecord) {
                        errorEl.textContent = '舊密語有誤。';
                        return;
                    }

                    const newPasswordHash = await hashString(newPassword);
                    await updateDoc(studentDocRef, { passwordHash: newPasswordHash });
                    
                    closeModal();
                    renderModal('message', { type: 'success', title: '更新成功', message: '憑信已成功修訂！' });
                } else {
                    throw new Error("Unknown user type.");
                }
            } catch (error) {
                console.error("Password change failed:", error);
                errorEl.textContent = '更新密語時發生錯誤。';
            } finally {
                hideLoading();
            }
        }

        async function handleResetPassword(classId, studentId) {
            const studentDocRef = doc(db, `classes/${classId}/students`, studentId);
            const studentDoc = await getDoc(studentDocRef);
            if (!studentDoc.exists()) { renderModal('message', { type: 'error', title: '錯誤', message: '找不到學生資料。' }); return; }
            
            const student = studentDoc.data();
            const selectedClass = appState.allClasses.find(c => c.id === classId);

            renderModal('confirm', {
                title: '確認重設密語',
                message: `您確定要將學子「${student.name}」的密語重設為預設值嗎？`,
                onConfirm: async () => {
                    showLoading('正在重設密語...');
                    try {
                        const defaultPassword = generateDefaultPassword(selectedClass.className, student.seatNumber);
                        const newPasswordHash = await hashString(defaultPassword);
                        await updateDoc(studentDocRef, { passwordHash: newPasswordHash });
                        hideLoading();
                        renderModal('message', { type: 'success', title: '重設成功', message: `學子「${student.name}」的密語已重設。` });
                    } catch (e) {
                        hideLoading();
                        console.error("重設密碼失敗:", e);
                        renderModal('message', { type: 'error', title: '重設失敗', message: '操作失敗，請稍後再試。' });
                    }
                }
            });
        }
        
        function handleTextSelection(event) {
            // Add a small delay for touch events to ensure selection is registered
            const delay = event.type === 'touchend' ? 50 : 10;
            
            setTimeout(() => {
                const selection = window.getSelection();
                if (!selection || selection.rangeCount === 0) {
                    // If no selection, hide the toolbar unless we clicked inside it
                    if (!dom.highlightToolbar.contains(event.target)) {
                        dom.highlightToolbar.classList.add('hidden');
                    }
                    return;
                }

                const range = selection.getRangeAt(0);
                appState.currentSelectionRange = range; // Always store the latest range

                // If the selection is not collapsed (i.e., text is selected), show the toolbar
                if (!selection.isCollapsed && selection.toString().trim() !== '') {
                    const rect = range.getBoundingClientRect();
                    const toolbar = dom.highlightToolbar;
                    toolbar.classList.remove('hidden');
                    // Position the toolbar near the end of the selection
                    const endRect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
                    toolbar.style.left = `${endRect.right + window.scrollX + 10}px`;
                    toolbar.style.top = `${endRect.top + window.scrollY}px`;
                } else {
                    // If selection is collapsed (a click/tap), check if it's inside a highlight
                    const container = range.commonAncestorContainer;
                    const highlight = container.nodeType === 1 ? container.closest('.highlight') : container.parentNode.closest('.highlight');

                    if (highlight) {
                        // If inside a highlight, show the toolbar next to the highlight
                        const rect = highlight.getBoundingClientRect();
                        const toolbar = dom.highlightToolbar;
                        toolbar.classList.remove('hidden');
                        toolbar.style.left = `${rect.right + window.scrollX + 10}px`;
                        toolbar.style.top = `${rect.top + window.scrollY}px`;
                    } else {
                        // If not inside a highlight, hide the toolbar
                        if (!dom.highlightToolbar.contains(event.target)) {
                            dom.highlightToolbar.classList.add('hidden');
                        }
                    }
                }
            }, delay);
        }

        function applyHighlight(color) {
            if (!appState.currentSelectionRange) return;

            const range = appState.currentSelectionRange;
            if (!range.collapsed) {
                const span = document.createElement('span');
                span.className = 'highlight';
                span.style.backgroundColor = color;
                span.appendChild(range.extractContents());
                range.insertNode(span);
            }

            // Clear the selection from the window and our state
            const selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            appState.currentSelectionRange = null;

            dom.highlightToolbar.classList.add('hidden');
            saveHighlights(appState.currentAssignment.id);
        }

        function removeHighlight() {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0) return;

            const range = selection.getRangeAt(0);
            const articleBody = document.getElementById('article-body');
            if (!articleBody) return;

            const unwrapHighlight = (el) => {
                const parent = el.parentNode;
                if (!parent) return;
                while (el.firstChild) {
                    parent.insertBefore(el.firstChild, el);
                }
                parent.removeChild(el);
            };

            // Case 1: A range of text is selected. Unwrap all highlights that intersect it.
            if (!range.collapsed) {
                const allHighlights = Array.from(articleBody.querySelectorAll('.highlight'));
                
                allHighlights.forEach(highlight => {
                    // Check if the highlight node intersects with the user's selection range
                    if (range.intersectsNode(highlight)) {
                        // A simple unwrap is sufficient for now. A more complex solution
                        // would involve splitting nodes if the selection is partial.
                        unwrapHighlight(highlight);
                    }
                });

            // Case 2: Selection is collapsed (it's a tap/click). Find the highlight under the cursor.
            } else {
                let node = range.commonAncestorContainer;
                const highlightNode = node.nodeType === 1 ? node.closest('.highlight') : node.parentNode.closest('.highlight');
                
                if (highlightNode) {
                    unwrapHighlight(highlightNode);
                }
            }

            // General cleanup
            articleBody.normalize(); // Merge adjacent text nodes
            selection.removeAllRanges();
            appState.currentSelectionRange = null;
            dom.highlightToolbar.classList.add('hidden');
            if (appState.currentAssignment) {
                saveHighlights(appState.currentAssignment.id);
            }
        }

        function saveHighlights(assignmentId) {
            if (!appState.currentUser || !appState.currentUser.studentId || !assignmentId) return;
            const articleBody = document.getElementById('article-body');
            if (articleBody) {
                const key = `highlights_${appId}_${appState.currentUser.studentId}_${assignmentId}`;
                try { localStorage.setItem(key, articleBody.innerHTML); } 
                catch (e) { console.error("儲存螢光筆劃記失敗:", e); }
            }
        }

        function loadAndApplyHighlights(assignmentId) {
            if (!appState.currentUser || !appState.currentUser.studentId || !assignmentId) return;
            const articleBody = document.getElementById('article-body');
            const key = `highlights_${appId}_${appState.currentUser.studentId}_${assignmentId}`;
            try {
                const savedHtml = localStorage.getItem(key);
                if (savedHtml && articleBody) articleBody.innerHTML = savedHtml;
            } catch (e) { console.error("讀取螢光筆劃記失敗:", e); }
        }
        

        function handleHighlightToolbarAction(event) {
            // Prevent the browser from doing its default action (like deselecting text or firing a click)
            event.preventDefault();
        
            const target = event.target;
            const highlightBtn = target.closest('.highlight-btn');
            const removeBtn = target.closest('#remove-highlight-btn');
        
            if (highlightBtn) {
                applyHighlight(highlightBtn.dataset.color);
            } else if (removeBtn) {
                removeHighlight();
            }
        }
        
        function setupEventListeners() {
            const genButton = document.getElementById('generate-questions-from-pasted-btn');
            if (genButton) {
                genButton.addEventListener('click', handleGenerateQuestionsFromPasted);
            }
            // New, more reliable event handling for the highlight toolbar
            // We use mousedown and touchstart to act immediately and prevent text deselection.
            dom.highlightToolbar.addEventListener('mousedown', handleHighlightToolbarAction);
            dom.highlightToolbar.addEventListener('touchstart', handleHighlightToolbarAction);

            // Use event delegation on the body for dynamically added elements
            document.body.addEventListener('click', e => {
                const target = e.target;

                // Login View
                if (target.closest('#teacher-login-link')) {
                    e.preventDefault();
                    renderModal('password');
                }
                if (target.closest('#student-login-btn')) {
                    handleStudentLogin();
                }

                // Main App View
                if (target.closest('#logout-btn')) {
                    handleLogout();
                }
                if (target.closest('#student-view-btn')) {
                    switchViewTab('student');
                }
                if (target.closest('#teacher-view-btn')) {
                    switchViewTab('teacher');
                }
                if (target.closest('#student-view-analysis-btn')) {
                    if(appState.currentUser && appState.currentUser.studentId) {
                        displayStudentAnalysis(appState.currentUser.studentId);
                    }
                }

                if (target.closest('#toggle-analysis-btn')) {
                    const articleBody = document.getElementById('article-body');
                    const analysisBody = document.getElementById('analysis-body');
                    const isShowingArticle = target.getAttribute('data-view') === 'article';

                    if (isShowingArticle) {
                        articleBody.classList.add('hidden');
                        analysisBody.classList.remove('hidden');
                        target.textContent = '返回原文';
                        target.setAttribute('data-view', 'analysis');
                    } else {
                        articleBody.classList.remove('hidden');
                        analysisBody.classList.add('hidden');
                        target.textContent = '查看解析';
                        target.setAttribute('data-view', 'article');
                    }
                }

                if(target.closest('.edit-analysis-ai-btn')) {
                    handleAnalysisAI(e);
                }
                if (target.closest('#student-view-achievements-btn')) {
                    renderAchievementsList();
                }
                 if (target.closest('#clear-article-filters-btn')) {
                     // Reset filter UI elements
                     document.getElementById('filter-format').value = '';
                    document.getElementById('filter-contentType').value = '';
                    document.getElementById('filter-difficulty').value = '';
                    document.getElementById('filter-status').value = '';
                    
                    // Reset filter state
                    appState.calendarFilterDate = null;
                    document.querySelectorAll('.calendar-day').forEach(d => d.classList.remove('bg-red-700', 'text-white'));
                    appState.articleQueryState.filters = {
                        format: '',
                        contentType: '',
                        difficulty: '',
                        status: '',
                    };
                    
                    // Fetch articles with cleared filters
                    fetchAssignmentsPage(true);
                }


                if (target.closest('#load-more-btn')) {
                    fetchAssignmentsPage(false);
                }
                if (target.closest('#load-more-teacher-articles-btn')) {
                    fetchTeacherAssignmentsPage(false);
                }

                // Student View (delegated from app-content-container)
                const assignmentItem = target.closest('.assignment-item');
                const assignmentCard = target.closest('.assignment-card-item');
                const targetElement = assignmentItem || assignmentCard;
                if (targetElement) {
                    const assignmentId = targetElement.dataset.assignmentId;
                    const assignment = appState.assignments.find(a => a.id === assignmentId);
                    if (assignment) displayAssignment(assignment);
                }
                
                // Highlight toolbar actions are now handled by their own dedicated listeners ('mousedown' and 'touchstart' on the toolbar itself).
            });

            document.body.addEventListener('change', e => {
                const target = e.target;

                // Login View
                if (target.matches('#class-login-selector')) {
                    populateStudentLoginSelector(target.value);
                }
                if (target.matches('#student-login-selector')) {
                    document.getElementById('student-login-btn').disabled = !target.value;
                }

                // Student View Filters
                if (target.matches('.article-filter')) {
                    const { id, value } = target;
                    const filterKey = id.replace('filter-', '');
                    appState.articleQueryState.filters[filterKey] = value;
                    fetchAssignmentsPage(true); // Re-fetch with new filters
                }

                // Teacher View Filters
                if (target.matches('.teacher-select-filter')) {
                    const { id, value } = target;
                    let filterKey = id.replace('filter-tag-', '').replace('filter-', '');
                    if (filterKey === 'deadline-status') {
                        filterKey = 'deadlineStatus'; // Convert to camelCase
                    }
                    appState.teacherArticleQueryState.filters[filterKey] = value;
                    fetchTeacherAssignmentsPage(true);
                }
            });

            document.body.addEventListener('input', e => {
                const target = e.target;
                if (target.matches('#article-search-input')) {
                    appState.teacherArticleQueryState.filters.searchTerm = target.value.toLowerCase();
                    // Debounce search to avoid excessive queries
                    clearTimeout(appState.teacherArticleQueryState.searchTimeout);
                    appState.teacherArticleQueryState.searchTimeout = setTimeout(() => {
                        fetchTeacherAssignmentsPage(true);
                    }, 300);
                }
            });
        }

        function setupTeacherEventListeners() {
            if (appState.isEventListenersInitialized) return;

            const mainAppView = dom.mainAppView;

            // Centralized click handler using event delegation
            mainAppView.addEventListener('click', (e) => {
                const target = e.target;
                const closest = (selector) => target.closest(selector);

                // --- Teacher View Tab Switching ---
                const teacherTabBtn = closest('.teacher-tab-btn');
                if (teacherTabBtn) {
                    const tabName = teacherTabBtn.dataset.tab;
                    switchTeacherTab(tabName);
                    return;
                }
                
                // --- Global Class Selector Actions ---
                switch (target.id) {
                    case 'teacher-analysis-btn':
                        displayStudentAnalysis('teacher_user');
                        return;
                    case 'save-api-key-btn':
                        handleSaveApiKey();
                        return;
                    case 'format-text-btn':
                        handleFormatText();
                        return;
                    case 'add-class-btn':
                        renderModal('prompt', {
                            title: '新設學堂',
                            message: '請為新學堂命名：',
                            onConfirm: async (className) => {
                                if (!className) {
                                    const errorEl = document.getElementById('prompt-error');
                                    if(errorEl) errorEl.textContent = '名號不可為空！';
                                    return;
                                }
                                closeModal();
                                showLoading('正在建立學堂...');
                                try {
                                    await addDoc(collection(db, "classes"), { className }); // Roster is no longer stored in the class document
                                    hideLoading();
                                    renderModal('message', { type: 'success', title: '新設成功', message: `學堂「${className}」已成功開設！` });
                                } catch (e) {
                                    hideLoading();
                                    console.error("新增班級失敗:", e);
                                    renderModal('message', { type: 'error', title: '新設失敗', message: '操作失敗，請稍後再試。' });
                                }
                            }
                        });
                        return; // Use return to avoid falling through
                    case 'edit-class-name-btn':
                        if (target.dataset.classId) handleEditClassName(target.dataset.classId);
                        return;
                    case 'delete-class-btn':
                        if (target.dataset.classId) handleDeleteClass(target.dataset.classId);
                        return;
                }

                // --- Achievement Panel Actions ---
                if (closest('#tab-panel-achievement-management')) {
                    const addBtn = closest('#add-achievement-btn');
                    if (addBtn) {
                        renderModal('achievementForm', {});
                        return;
                    }

                    const editBtn = closest('.edit-achievement-btn');
                    if (editBtn) {
                        const achievementId = editBtn.dataset.id;
                        handleEditAchievement(achievementId);
                        return;
                    }

                    const deleteBtn = closest('.delete-achievement-btn');
                    if (deleteBtn) {
                        const achievementId = deleteBtn.dataset.id;
                        handleDeleteAchievement(achievementId);
                        return;
                    }
                }

                // --- Class Roster Panel Actions (Specific to the panel) ---
                if (closest('#tab-panel-class-overview')) {
                    const nameLink = closest('.student-name-link');
                    if (nameLink) {
                        const studentId = nameLink.dataset.studentId;
                        // The classId is now on the panel container
                        const classId = closest('#class-management-content')?.dataset.classId;
                        if (studentId && classId) {
                            displayStudentAnalysis(studentId, classId);
                        } else {
                            console.error('Could not determine studentId or classId for analysis.');
                        }
                        return;
                    }
                    
                    const rosterButton = closest('button');
                    if (rosterButton) {
                         const { classId, studentId } = rosterButton.dataset;
                        if (rosterButton.classList.contains('edit-student-btn')) { if (classId && studentId) handleEditStudent(classId, studentId); }
                        else if (rosterButton.classList.contains('delete-student-btn')) { if (classId && studentId) handleDeleteStudent(classId, studentId); }
                        else if (rosterButton.classList.contains('reset-password-btn')) { if (classId && studentId) handleResetPassword(classId, studentId); }
                        else if (rosterButton.id === 'add-student-btn') { if(classId) handleAddStudent(classId); }
                        else if (rosterButton.id === 'bulk-import-btn') { if(classId) handleBulkImport(classId); }
                        else if (rosterButton.id === 'generate-overdue-report-btn') { if(classId) renderOverdueReport(classId); }
                    }
                }

                // --- Article Library Actions ---
                const editBtn = closest('.edit-article-btn');
                if (editBtn) {
                    handleEditArticle(e);
                    return;
                }

                const deleteBtn = closest('.delete-article-btn');
                if (deleteBtn) {
                    handleDeleteArticle(e);
                    return;
                }

                const titleLink = closest('.article-title-link');
                if (titleLink) {
                    e.preventDefault();
                    const articleId = titleLink.dataset.assignmentId;
                    renderArticleAnalysisModal(articleId);
                    return;
                }

                // Other buttons by ID
                switch (target.id) {
                    case 'bulk-delete-btn':
                        handleBulkDelete();
                        break;
                    case 'bulk-set-public-btn':
                        bulkUpdatePublicStatus(true);
                        break;
                    case 'bulk-set-private-btn':
                        bulkUpdatePublicStatus(false);
                        break;
                    case 'generate-btn':
                        generateAssignment();
                        break;
                    case 'generate-questions-btn':
                        handleGenerateQuestionsFromPasted();
                        break;
                    case 'ai-analysis-btn': // The one in the teacher panel
                         const articleId = document.getElementById('analysis-panel')?.dataset.articleId;
                         if(articleId) handleAiAnalysis(articleId);
                         else renderModal('message', {type:'info', title:'提示', message:'請先選擇一篇文章'});
                        break;
                    case 'tab-create-article':
                        document.getElementById('tab-create-article').classList.add('active');
                        document.getElementById('tab-analyze-article').classList.remove('active');
                        document.getElementById('panel-create-article').classList.remove('hidden');
                        document.getElementById('panel-analyze-article').classList.add('hidden');
                        break;
                    case 'tab-analyze-article':
                        document.getElementById('tab-analyze-article').classList.add('active');
                        document.getElementById('tab-create-article').classList.remove('active');
                        document.getElementById('panel-analyze-article').classList.remove('hidden');
                        document.getElementById('panel-create-article').classList.add('hidden');
                        break;
                    case 'tab-ai-generate':
                        document.getElementById('tab-ai-generate').classList.add('active');
                        document.getElementById('tab-paste-text').classList.remove('active');
                        document.getElementById('panel-ai-generate').classList.remove('hidden');
                        document.getElementById('panel-paste-text').classList.add('hidden');
                        break;
                    case 'tab-paste-text':
                        document.getElementById('tab-paste-text').classList.add('active');
                        document.getElementById('tab-ai-generate').classList.remove('active');
                        document.getElementById('panel-paste-text').classList.remove('hidden');
                        document.getElementById('panel-ai-generate').classList.add('hidden');
                        break;
                }
            });

            // Centralized input handler
            mainAppView.addEventListener('input', (e) => {
                if (e.target.id === 'article-search-input') {
                    applyArticleFilters();
                }
            });

            // Centralized change handler
            mainAppView.addEventListener('change', (e) => {
                const target = e.target;
                const targetId = target.id;

                if (targetId === 'class-selector') {
                    const newClassId = target.value;
                    const activeTab = document.querySelector('.teacher-tab-btn.active')?.dataset.tab;
                    if (activeTab === 'class-overview') {
                        renderClassManagement(newClassId);
                    } else if (activeTab === 'article-library') {
                        updateArticleLibraryPanel(newClassId);
                    }
                } else if (targetId === 'select-all-articles' || target.classList.contains('article-checkbox')) {
                    if (targetId === 'select-all-articles') {
                        document.querySelectorAll('.article-checkbox').forEach(checkbox => {
                            checkbox.checked = target.checked;
                        });
                    } else {
                        const selectAllCheckbox = document.getElementById('select-all-articles');
                        if (!target.checked) {
                            if (selectAllCheckbox) selectAllCheckbox.checked = false;
                        } else {
                            const allChecked = Array.from(document.querySelectorAll('.article-checkbox')).every(cb => cb.checked);
                            if (selectAllCheckbox) selectAllCheckbox.checked = allChecked;
                        }
                    }
                    updateBulkActionsVisibility();
                } else if (['filter-tag-format', 'filter-tag-contentType', 'filter-tag-difficulty', 'filter-deadline-status'].includes(targetId)) {
                    const filterKey = targetId.replace('filter-tag-', '').replace('filter-', '');
                    appState.teacherArticleQueryState.filters[filterKey] = e.target.value;
                    fetchTeacherAssignmentsPage(true);
                }
            });
            
            appState.isEventListenersInitialized = true;
        }

        function switchTeacherTab(tabName, classId = null, articleId = null) {
            const panels = ['class-overview', 'article-library', 'achievement-management', 'system-settings'];
            
            panels.forEach(panel => {
                const panelEl = document.getElementById(`tab-panel-${panel}`);
                const tabEl = document.querySelector(`.teacher-tab-btn[data-tab="${panel}"]`);
                if (panelEl) panelEl.classList.add('hidden');
                if (tabEl) tabEl.classList.remove('active');
            });

            const activePanel = document.getElementById(`tab-panel-${tabName}`);
            const activeTab = document.querySelector(`.teacher-tab-btn[data-tab="${tabName}"]`);

            if (activePanel) activePanel.classList.remove('hidden');
            if (activeTab) activeTab.classList.add('active');

            switch (tabName) {
                case 'class-overview':
                    const selectedClassId = classId || document.getElementById('class-selector')?.value;
                    renderClassManagement(selectedClassId);
                    break;
                case 'article-library':
                    updateArticleLibraryPanel(classId, articleId);
                    break;
                case 'achievement-management':
                    renderAchievementManagement();
                    break;
               case 'system-settings':
                   renderSystemSettings();
                   break;
            }
        }
        

        function updateBulkActionsVisibility() {
            const anyChecked = document.querySelectorAll('.article-checkbox:checked').length > 0;
            const bulkActionsContainer = document.getElementById('bulk-actions-container');
            if (bulkActionsContainer) {
                bulkActionsContainer.classList.toggle('hidden', !anyChecked);
            }
        }

        // --- Achievement System ---

        async function checkAndAwardAchievements(studentId, eventType, studentData, eventData = {}) {
            console.log(`Checking achievements for ${studentData.name}, event: ${eventType}`, 'Received studentData:', studentData);
            if (!studentId || !studentData) return 0;
            let unlockedCount = 0;

            // Helper function to check a single condition
            async function checkSingleCondition(condition, studentData, eventType, studentSubmissions, eventData) {
                let isMet = false;
                const value = parseInt(condition.value, 10);
                // Some conditions might not need a value.
                if (condition.type !== 'weekly_progress' && isNaN(value)) return false;

                switch (condition.type) {
                    case 'submission_count':
                        if (studentSubmissions && studentSubmissions.length >= value) {
                            isMet = true;
                        }
                        break;
                    case 'login_streak':
                        console.log(`Checking login_streak: student has ${studentData.loginStreak || 0}, needs ${value}`);
                        if ((studentData.loginStreak || 0) >= value) {
                            isMet = true;
                        }
                        break;
                    case 'high_score_streak':
                        if ((studentData.highScoreStreak || 0) >= value) {
                            isMet = true;
                        }
                        break;
                    case 'completion_streak':
                        console.log(`Checking completion_streak: student has ${studentData.completionStreak || 0}, needs ${value}`);
                        if ((studentData.completionStreak || 0) >= value) {
                            isMet = true;
                        }
                        break;
                    case 'average_score':
                        if (studentSubmissions && studentSubmissions.length > 0) {
                            const totalScore = studentSubmissions.reduce((sum, s) => sum + s.score, 0);
                            const avgScore = totalScore / studentSubmissions.length;
                            if (avgScore >= value) {
                                isMet = true;
                            }
                        }
                        break;
                    case 'genre_explorer':
                        const tagCounts = studentData.tagReadCounts || {};
                        const completedGenres = Object.keys(tagCounts).filter(key => key.startsWith('contentType_')).length;
                        if (completedGenres >= value) {
                            isMet = true;
                        }
                        break;
                    case 'weekly_progress':
                        // New logic: Compare last full week with the week before that.
                        // This check should only run ONCE per week.
                        const now = new Date();
                        const currentWeekId = getWeekId(now);

                        // 1. Check if we've already run this check this week.
                        if (studentData.lastProgressCheckWeekId === currentWeekId) {
                            break; // Already checked this week, do nothing.
                        }

                        // 2. Immediately mark this week as checked to prevent re-runs.
                        // We do this first to ensure it's always updated, even if the user navigates away.
                        // This is an async operation, but we don't need to wait for it.
                        // The studentId is passed as the first argument to checkAndAwardAchievements
                        const studentRef = doc(db, `classes/${studentData.classId}/students`, studentId);
                        updateDoc(studentRef, { lastProgressCheckWeekId: currentWeekId }).catch(console.error);
                        
                        // 3. Define date ranges for last week and the week before.
                        const startOfThisWeek = getStartOfWeek(now);
                        const startOfLastWeek = new Date(startOfThisWeek.getTime() - 7 * 24 * 60 * 60 * 1000);
                        const endOfLastWeek = new Date(startOfThisWeek.getTime() - 1); // End of Sunday
                        const startOfPrevWeek = new Date(startOfLastWeek.getTime() - 7 * 24 * 60 * 60 * 1000);
                        const endOfPrevWeek = new Date(startOfLastWeek.getTime() - 1);

                        // 4. Filter submissions and calculate total scores.
                        const lastWeekSubmissions = studentSubmissions.filter(s => {
                            const subDate = s.submittedAt.toDate();
                            return subDate >= startOfLastWeek && subDate <= endOfLastWeek;
                        });

                        const prevWeekSubmissions = studentSubmissions.filter(s => {
                            const subDate = s.submittedAt.toDate();
                            return subDate >= startOfPrevWeek && subDate <= endOfPrevWeek;
                        });

                        const lastWeekTotalScore = lastWeekSubmissions.reduce((sum, s) => sum + s.score, 0);
                        const prevWeekTotalScore = prevWeekSubmissions.reduce((sum, s) => sum + s.score, 0);
                        
                        // 5. Compare scores to see if progress was made.
                        // We only award progress if the previous week had activity, to make it meaningful.
                        if (lastWeekTotalScore > 0 && lastWeekTotalScore > prevWeekTotalScore) {
                           isMet = true;
                        }
                        break;
                    default:
                        if (condition.type && condition.type.startsWith('read_tag_')) {
                            const key = condition.type.replace('read_tag_', '');
                            const tagCount = (studentData.tagReadCounts || {})[key] || 0;
                            if (tagCount >= value) {
                                isMet = true;
                            }
                        }
                        break;
                }
                return isMet;
            }

            try {
                // 1. Get all enabled achievements
                const achievementsQuery = query(collection(db, "achievements"), where("isEnabled", "==", true));
                const achievementsSnapshot = await getDocs(achievementsQuery);
                if (achievementsSnapshot.empty) return 0;
                const allAchievements = achievementsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // 2. Get student's unlocked achievements
                const unlockedQuery = query(collection(db, "student_achievements"), where("studentId", "==", studentId));
                const unlockedSnapshot = await getDocs(unlockedQuery);
                const unlockedMap = new Map(unlockedSnapshot.docs.map(doc => [doc.data().achievementId, { id: doc.id, ...doc.data() }]));

                // 3. Get all submissions for the student (only if needed and not already provided)
                let studentSubmissions = eventData.submissions || null;
                if (studentSubmissions === null) {
                     const needsSubmissions = allAchievements.some(ach => {
                        const isUnlocked = unlockedMap.has(ach.id);
                        // If it's repeatable, we might always need to check. If not repeatable and unlocked, skip.
                        if (!ach.isRepeatable && isUnlocked) return false;
                        
                        const hasDataHeavyCondition = (conditions) => conditions.some(c =>
                            c.type.includes('score') || c.type === 'submission_count' || c.type.includes('tag') || c.type === 'weekly_progress'
                        );

                        if (ach.conditions) return hasDataHeavyCondition(ach.conditions);
                        if (ach.type) return hasDataHeavyCondition([{type: ach.type}]); // Check old format
                        return false;
                     });

                    if (needsSubmissions) {
                        studentSubmissions = await loadStudentSubmissions(studentId);
                    }
                }
                
                // 4. Iterate and check each achievement
                for (const ach of allAchievements) {
                    const existingUnlock = unlockedMap.get(ach.id);
                    if (!ach.isRepeatable && existingUnlock) {
                        continue; // Skip non-repeatable, already unlocked achievements
                    }

                    let allConditionsMet = false;
                    if (ach.conditions && Array.isArray(ach.conditions) && ach.conditions.length > 0) {
                        let conditionsResult = true;
                        for (const condition of ach.conditions) {
                            if (!await checkSingleCondition(condition, studentData, eventType, studentSubmissions, eventData)) {
                                conditionsResult = false;
                                break;
                            }
                        }
                        if (conditionsResult) allConditionsMet = true;
                    } else if (ach.type) { // Backward compatibility
                        if (await checkSingleCondition(ach, studentData, eventType, studentSubmissions, eventData)) {
                            allConditionsMet = true;
                        }
                    }

                    if (allConditionsMet) {
                        unlockedCount++;
                        let newCount = 1;

                        if (ach.isRepeatable) {
                            if (existingUnlock) {
                                newCount = (existingUnlock.count || 1) + 1;
                                const docRef = doc(db, "student_achievements", existingUnlock.id);
                                await updateDoc(docRef, {
                                    count: newCount,
                                    unlockedAt: Timestamp.now()
                                });
                            } else {
                                await addDoc(collection(db, "student_achievements"), {
                                    studentId: studentId,
                                    achievementId: ach.id,
                                    unlockedAt: Timestamp.now(),
                                    classId: appState.currentUser.classId,
                                    count: newCount
                                });
                            }
                        } else { // Not repeatable, and we already know it's not unlocked
                            await addDoc(collection(db, "student_achievements"), {
                                studentId: studentId,
                                achievementId: ach.id,
                                unlockedAt: Timestamp.now(),
                                classId: appState.currentUser.classId
                            });
                        }
                        
                        // Update map to prevent re-awarding in the same run
                        unlockedMap.set(ach.id, { ...unlockedMap.get(ach.id), count: newCount });

                        renderModal('achievementUnlocked', {
                            icon: ach.icon,
                            title: ach.name,
                            description: ach.description,
                            count: ach.isRepeatable ? newCount : null
                        });
                    }
                }
            } catch (error) {
                console.error("Error during achievement check:", error);
            }
            return unlockedCount;
        }

        // Helper function to extract sorting keys from an achievement
        // --- Achievement Helper Functions ---

        /**
         * Returns the start of the week (Monday) for a given date.
         * @param {Date} date The input date.
         * @returns {Date} The date of the Monday of that week, at 00:00:00.
         */
        function getStartOfWeek(date) {
            const d = new Date(date);
            const day = d.getDay();
            const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday (0)
            const startOfWeek = new Date(d.setDate(diff));
            startOfWeek.setHours(0, 0, 0, 0);
            return startOfWeek;
        }

        /**
         * Generates a unique week identifier (e.g., "2024-W32") for a given date.
         * @param {Date} date The input date.
         * @returns {string} The week identifier string.
         */
        function getWeekId(date) {
            const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
            // Set to nearest Thursday: current date + 4 - current day number
            d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
            // Get first day of year
            const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
            // Calculate full weeks to nearest Thursday
            const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
            // Return YYYY-WW
            return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
        }

        function getAchievementSortKeys(ach) {
            let type, value, conditionCount;

            if (ach.conditions && ach.conditions.length > 0) {
                type = ach.conditions[0].type;
                value = parseInt(ach.conditions[0].value, 10);
                conditionCount = ach.conditions.length;
            } else { // Legacy format
                type = ach.type;
                value = parseInt(ach.value, 10);
                conditionCount = 1;
            }
            if (isNaN(value)) value = 0; // Handle types without a value like 'weekly_progress'
            return { type, value, conditionCount };
        }
        async function renderAchievementsList() {
            if (!appState.currentUser || !appState.currentUser.studentId) return;
            showLoading('讀取成就...');

            try {
                // Fetch all achievement definitions
                // Fetch all achievement definitions from the root collection
                const achievementsQuery = query(collection(db, "achievements"), orderBy("createdAt", "desc"));
                const allAchievementsSnapshot = await getDocs(achievementsQuery);
                const allAchievements = allAchievementsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

                // Fetch unlocked achievements for the current student
                // Fetch unlocked achievements for the current student from the root collection
                const unlockedQuery = query(collection(db, "student_achievements"), where("studentId", "==", appState.currentUser.studentId));
                const unlockedSnapshot = await getDocs(unlockedQuery);
                const unlockedAchievements = unlockedSnapshot.docs.map(doc => doc.data());

                // This is the desired order, based on the form dropdown.
                const typeOrder = [
                    'submission_count', 'login_streak', 'high_score_streak', 'completion_streak',
                    'average_score', 'genre_explorer', 'weekly_progress',
                    'read_tag_contentType_記敘', 'read_tag_contentType_抒情', 'read_tag_contentType_說明', 'read_tag_contentType_議論', 'read_tag_contentType_應用',
                    'read_tag_difficulty_基礎', 'read_tag_difficulty_普通', 'read_tag_difficulty_進階', 'read_tag_difficulty_困難'
                ];

                const unlockedIds = new Set(unlockedAchievements.map(ua => ua.achievementId));
                
                const filteredAndSorted = allAchievements
                    .filter(ach => ach.isEnabled && (!ach.isHidden || unlockedIds.has(ach.id)))
                    .sort((a, b) => {
                        const keysA = getAchievementSortKeys(a);
                        const keysB = getAchievementSortKeys(b);

                        const indexA = typeOrder.indexOf(keysA.type);
                        const indexB = typeOrder.indexOf(keysB.type);

                        if (indexA !== indexB) {
                            if (indexA === -1) return 1;
                            if (indexB === -1) return -1;
                            return indexA - indexB;
                        }
                        if (keysA.conditionCount !== keysB.conditionCount) {
                            return keysA.conditionCount - keysB.conditionCount;
                        }
                        return keysA.value - keysB.value;
                    });

                const modalAchievements = filteredAndSorted.map(ach => ({
                    id: ach.id,
                    title: ach.name,
                    description: ach.description,
                    icon: ach.icon
                }));

                await renderModal('achievementsList', {
                    allAchievements: modalAchievements,
                    unlockedAchievements
                });

            } catch (error) {
                console.error("Error rendering achievements list:", error);
                renderModal('message', { title: '錯誤', message: '無法載入成就列表。' });
            } finally {
                hideLoading();
            }
        }
        function getConditionTypeName(type) {
            const typeNames = {
                'submission_count': '閱讀篇數',
                'login_streak': '連續登入',
                'high_score_streak': '高分連勝',
                'average_score': '平均分數',
                'genre_explorer': '探索體裁',
                'specific_assignment': '完成特定任務',
                'specific_score': '達成特定分數',
                'manual_award': '手動授予'
            };
            // Handle dynamic tag-based types
            if (type.startsWith('read_tag_')) {
                const parts = type.split('_');
                if (parts.length === 4) {
                    const [, , category, value] = parts;
                    return `閱讀 ${category}:${value}`;
                }
            }
            return typeNames[type] || type;
        }


        async function renderAchievementManagement() {
            const panel = document.getElementById('achievement-management-content');
            if (!panel) return;

            panel.innerHTML = ''; // Clear previous content
            const container = el('div', { class: 'p-1' }); // Adjusted padding
            panel.appendChild(container);

            const header = el('div', { class: 'flex justify-between items-center mb-6' }, [
                el('h2', { class: 'text-2xl font-bold text-gray-800 font-rounded', textContent: '成就管理' }),
                el('button', { id: 'add-achievement-btn', class: 'btn-primary py-2 px-4', textContent: '新增成就' })
            ]);
            container.appendChild(header);

            const listContainer = el('div', { id: 'achievement-list-container', class: 'space-y-4' });
            container.appendChild(listContainer);
            
            listContainer.innerHTML = '<p>正在讀取成就設定...</p>';

            try {
                const achievementsQuery = query(collection(db, "achievements"), orderBy("createdAt", "desc"));
                const querySnapshot = await getDocs(achievementsQuery);

                listContainer.innerHTML = ''; // Clear loading message

                if (querySnapshot.empty) {
                    listContainer.appendChild(el('p', { class: 'text-gray-500' }, ['尚未建立任何成就。點擊「新增成就」來建立第一個。']));
                    return;
                }

                querySnapshot.forEach(doc => {
                    const ach = { id: doc.id, ...doc.data() };
                    const card = el('div', { class: 'card flex items-center justify-between p-4' }, [
                        el('div', { class: 'flex items-center gap-4 flex-grow' }, [
                            el('div', { class: 'text-3xl w-12 text-center', innerHTML: ach.icon || '🏆' }),
                            el('div', { class: 'flex-grow' }, [
                                el('h3', { class: 'font-bold text-lg flex items-center flex-wrap' }, [
                                    el('span', { textContent: ach.name }),
                                    el('span', { class: `ml-2 text-xs font-semibold px-2 py-0.5 rounded-full ${ach.isEnabled ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`, textContent: ach.isEnabled ? '啟用中' : '已停用' }),
                                    ach.isHidden ? el('span', { class: 'ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800', textContent: '隱藏' }) : null
                                ]),
                                el('p', { class: 'text-sm text-gray-600', textContent: ach.description }),
                                el('div', { class: 'text-xs text-gray-500 mt-1 flex flex-wrap gap-1' },
                                    (ach.conditions && ach.conditions.length > 0)
                                        ? ach.conditions.map(c => el('code', { class: 'bg-gray-100 px-1 rounded' }, [`${getConditionTypeName(c.type)}: ${c.value}`]))
                                        : [
                                            el('code', { class: 'bg-gray-100 px-1 rounded', textContent: `類型: ${ach.type || 'N/A'}` }),
                                            el('code', { class: 'bg-gray-100 px-1 rounded', textContent: `條件值: ${ach.value || 'N/A'}` })
                                          ]
                                )
                            ])
                        ]),
                        el('div', { class: 'flex gap-2 flex-shrink-0 ml-4' }, [
                            el('button', { 'data-id': ach.id, class: 'edit-achievement-btn btn-secondary py-2 px-4 text-sm', textContent: '編輯' }),
                            el('button', { 'data-id': ach.id, class: 'delete-achievement-btn btn-danger py-2 px-4 text-sm', textContent: '刪除' })
                        ])
                    ]);
                    listContainer.appendChild(card);
                });

            } catch (error) {
                console.error("Error rendering achievement management:", error);
                listContainer.innerHTML = '<p class="text-red-500">讀取成就設定失敗。</p>';
            }
        }

        document.addEventListener('DOMContentLoaded', initializeAppCore);


// =================================================================================
// Achievement Management Functions (Global Scope)
// =================================================================================

async function handleSaveAchievement(achievementId) {
    const name = document.getElementById('ach-name').value.trim();
    const description = document.getElementById('ach-description').value.trim();
    const icon = document.getElementById('ach-icon').value.trim();
    const isEnabled = document.getElementById('ach-isEnabled').checked;
    const isHidden = document.getElementById('ach-isHidden').checked;
    const isRepeatable = document.getElementById('ach-isRepeatable').checked;
    const errorEl = document.getElementById('ach-form-error');
    errorEl.textContent = '';

    // --- New: Collect conditions from dynamic form ---
    const conditions = [];
    const conditionBlocks = document.querySelectorAll('.condition-block');
    let formIsValid = true;

    const typesWithoutValue = ['weekly_progress'];

    for (let i = 0; i < conditionBlocks.length; i++) {
        const block = conditionBlocks[i];
        const type = block.querySelector('.ach-condition-type').value;
        const value = block.querySelector('.ach-condition-value').value;

        if (!type) {
            errorEl.textContent = `第 ${i + 1} 個條件的類型必須選擇。`;
            formIsValid = false;
            break;
        }

        // If the type does not require a value, we can skip the value checks
        if (typesWithoutValue.includes(type)) {
            conditions.push({ type });
            continue;
        }

        // For all other types, value is required and must be a number
        if (value === '') {
            errorEl.textContent = `第 ${i + 1} 個條件的值必須填寫。`;
            formIsValid = false;
            break;
        }
        const valueAsNumber = parseInt(value, 10);
        if (isNaN(valueAsNumber)) {
            errorEl.textContent = `第 ${i + 1} 個條件的值必須是數字。`;
            formIsValid = false;
            break;
        }
        conditions.push({ type, value: valueAsNumber });
    }

    if (!formIsValid) return;

    if (!name || !description) {
        errorEl.textContent = '請填寫成就名稱和描述。';
        return;
    }
    if (conditions.length === 0) {
        errorEl.textContent = '請至少新增一個成就條件。';
        return;
    }
    
    showLoading('儲存中...');

    try {
        const achievementData = {
            name,
            description,
            icon,
            conditions, // New conditions array
            isEnabled,
            isHidden,
            isRepeatable
        };

        if (achievementId) {
            // Editing existing: add fields to remove old structure
            const updateData = {
                ...achievementData,
                updatedAt: Timestamp.now(),
                type: deleteField(),
                value: deleteField()
            };
            const docRef = doc(db, 'achievements', achievementId);
            await updateDoc(docRef, updateData);
        } else {
            // Creating new
            const createData = {
                ...achievementData,
                createdAt: Timestamp.now()
            };
            await addDoc(collection(db, 'achievements'), createData);
        }

        hideLoading();
        closeModal();
        renderAchievementManagement(); // Refresh the list
        renderModal('message', { type: 'success', title: '儲存成功', message: `成就「${name}」已成功儲存。` });

    } catch (error) {
        hideLoading();
        console.error("儲存成就失敗:", error);
        errorEl.textContent = '儲存失敗，請稍後再試。';
    }
}

async function handleEditAchievement(achievementId) {
    if (!achievementId) return;
    showLoading('正在讀取成就資料...');
    try {
        const docRef = doc(db, `achievements`, achievementId);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const achievementData = { id: docSnap.id, ...docSnap.data() };
            hideLoading();
            renderModal('achievementForm', { achievement: achievementData });
        } else {
            hideLoading();
            renderModal('message', { type: 'error', title: '錯誤', message: '找不到指定的成就資料。' });
        }
    } catch (error) {
        hideLoading();
        console.error("讀取成就失敗:", error);
        renderModal('message', { type: 'error', title: '讀取失敗', message: '無法讀取成就資料，請稍後再試。' });
    }
}

async function handleDeleteAchievement(achievementId) {
    if (!achievementId) return;
    
    try {
        const docRef = doc(db, `achievements`, achievementId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
            const achievementName = docSnap.data().name || '該成就';
            renderModal('confirm', {
                title: '確認刪除成就',
                message: `您確定要永久刪除「${escapeHtml(achievementName)}」嗎？此操作無法復原。`,
                onConfirm: () => confirmDeleteAchievement(achievementId)
            });
        } else {
             renderModal('message', { type: 'error', title: '錯誤', message: '找不到指定的成就資料。' });
        }
    } catch (error) {
        console.error("讀取成就名稱失敗:", error);
        renderModal('message', { type: 'error', title: '操作失敗', message: '無法讀取成就資料，請稍後再試。' });
    }
}

async function confirmDeleteAchievement(achievementId) {
    closeModal(); // Close the confirmation modal
    showLoading('正在刪除成就...');
    try {
        const docRef = doc(db, `achievements`, achievementId);
        await deleteDoc(docRef);
        hideLoading();
        renderModal('message', { type: 'success', title: '刪除成功', message: '成就已成功刪除。' });
        renderAchievementManagement(); // Refresh the list
    } catch (error) {
        hideLoading();
        console.error("刪除成就失敗:", error);
        renderModal('message', { type: 'error', title: '刪除失敗', message: '操作失敗，請稍後再試。' });
    }
}

// #region Student Management
async function loadStudentsForClass(classId) {
    // Return cached data if available
    if (appState.students && appState.students[classId]) {
        return appState.students[classId];
    }

    try {
        const studentsRef = collection(db, `classes/${classId}/students`);
        const snapshot = await getDocs(studentsRef);
        
        if (snapshot.empty) {
            console.log(`學堂 ${classId} 中沒有學生。`);
            if (!appState.students) { appState.students = {}; }
            appState.students[classId] = []; // Cache empty result
            return [];
        }
        
        const studentList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        if (!appState.students) { appState.students = {}; }
        appState.students[classId] = studentList; // Cache the list
        return studentList;
    } catch (error) {
        console.error(`無法載入學堂 ${classId} 的學生:`, error);
        // In case of error, return null to let the caller handle it
        return null;
    }
}
// #endregion

async function handleAiGenerateAchievement() {
    const errorEl = document.getElementById('ach-form-error');
    if(errorEl) errorEl.textContent = '';

    // 1. 獲取類型與中文名稱的對照表
    const conditionOptions = modalHtmlGenerators.achievementForm.conditionOptions;
    if (!conditionOptions) {
        if(errorEl) errorEl.textContent = '錯誤：找不到條件選項。';
        return;
    }
    const typeToNameMap = new Map();
    conditionOptions.forEach(group => {
        group.options.forEach(opt => {
            typeToNameMap.set(opt.value, opt.text);
        });
    });

    // 2. 收集現有表單數據，並附上中文類型名稱
    const conditions = [];
    document.querySelectorAll('.condition-block').forEach(block => {
        const type = block.querySelector('.ach-condition-type').value;
        const value = block.querySelector('.ach-condition-value').value;
        conditions.push({
            type: type || "",
            typeName: type ? typeToNameMap.get(type) || "" : "", // 新增的欄位
            value: value || ""
        });
    });

    const currentAchievement = {
        name: document.getElementById('ach-name').value || "",
        description: document.getElementById('ach-description').value || "",
        icon: document.getElementById('ach-icon').value || "",
        conditions: conditions
    };

    // 3. 建立更具主題風格、包含更多上下文的 prompt
    const prompt = `
你是一位學識淵博、想像力豐富的書院總教習。你的任務是為一個線上學習平台的成就系統，設計充滿創意與文藝氣息的獎勵。

# 核心原則
- **主題**：靈感必須源於中國古典文學、歷史典故、文人雅趣（如琴棋書畫、山水遊歷、品茗論道）或神話傳說。
- **風格**：擺脫呆板的四字成語。追求更有畫面感、更獨特的稱號。可以是一個詩句、一個稱謂、或是一個典故的精煉。
- **創意**：名稱和圖示都必須有巧思，避免陳腔濫調。

# 輸出格式
你必須嚴格回傳一個 JSON 物件，不包含任何 JSON 以外的文字。JSON 結構如下：
{
  "name": "string",
  "description": "string",
  "icon": "string",
  "reasoning": "string",
  "conditions": [ { "type": "string", "value": "number" } ]
}

# 欄位詳細說明
1.  **name (成就稱號)**：
    *   **要求**：一個富有創意和文學氣息的稱號，**長度不限**。
    *   **範例**：「筆落驚風雨」、「腹有詩書氣自華」、「行萬里路者」、「一葦渡江」。

2.  **description (描述)**：
    *   **要求**：用典雅的文字描述此成就，並在結尾用括號註明清楚的達成條件。
    *   **範例**：「下筆如有神助，文思泉湧，令人驚嘆。（完成 10 篇『議論』文章。）」

3.  **icon (圖示)**：
    *   **要求**：從下方的「靈感圖示庫」中，挑選一個最能對應成就意象的 emoji。**不要重複使用已有的圖示**，除非意境高度契合。
    *   **靈感圖示庫**: 📜✒️🏮🏔️🍵🏞️🐉鳳舟劍琴棋書畫🌊🔥⭐🌙☀️🌱🌳💎🗝️🗺️🧭⛩️

4.  **reasoning (設計理念)**：
    *   **要求**：**(此欄位為必要)** 簡要說明你為何如此命名，以及圖示選擇的理由。這能展現你的巧思。
    *   **範例**：「『筆落驚風雨』取自杜甫詩句，比喻文采出眾；圖示選用『✒️』，象徵創作的筆。」

5.  **conditions (條件列表)**：
    *   **要求**：這是成就的觸發條件，也是你創意的核心依據。
    *   如果輸入的 \`conditions\` 陣列為空，請為其新增一個合理的條件。
    *   如果 \`conditions\` 中的物件有空值，請為其設定合理的 \`type\` 和 \`value\`。
    *   **可用的 type**：'submission_count', 'login_streak', 'high_score_streak', 'average_score', 'genre_explorer', 'read_tag_contentType_記敘', 'read_tag_difficulty_困難' 等。

# 你的任務
根據下方提供的 JSON 資料，補完所有值為空字串("")的欄位，並回傳一個完整的 JSON 物件。

**目前的成就資料 (請參考 'typeName' 欄位發想):**
${JSON.stringify(currentAchievement, null, 2)}
`;

    await callAchievementAI(prompt);
}

async function callAchievementAI(prompt) {
    const aiButton = document.getElementById('ai-generate-achievement-btn');
    const errorEl = document.getElementById('ach-form-error');
    if (!aiButton || !errorEl) return;

    // 使用 config.js 中的變數
    if (!appState.geminiApiKey) {
        errorEl.textContent = '錯誤：找不到或尚未設定您的 AI API 金鑰，請至「系統設定」頁面設定。';
        return;
    }

    const originalText = aiButton.textContent;
    aiButton.disabled = true;
    aiButton.innerHTML = '<div class="loader-sm"></div> 發想中...';
    errorEl.textContent = '';

    try {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${appState.geminiApiKey}`;

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.8,
                    maxOutputTokens: 1024,
                    responseMimeType: "application/json",
                },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ]
            })
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error("AI API Error Body:", errorBody);
            throw new Error(`請求失敗(${response.status})。 ${errorBody}`);
        }

        const data = await response.json();
        
        if (!data.candidates || data.candidates.length === 0) {
            console.error("AI Response Blocked or Empty:", data);
            const blockReason = data.promptFeedback?.blockReason || '未知原因';
            throw new Error(`AI 回應被阻擋。原因: ${blockReason}`);
        }

        let idea;
        const part = data.candidates[0]?.content?.parts?.[0];

        if (part && part.text) {
            const jsonString = part.text.trim();
            idea = JSON.parse(jsonString);
        } else {
            console.error("Unexpected AI Response Structure:", data);
            throw new Error("AI 回應格式不正確 (缺少 text 內容)。");
        }

        // --- New: Smartly populate the form, including dynamic conditions ---

        // Populate basic fields
        const nameInput = document.getElementById('ach-name');
        if (nameInput && !nameInput.value && idea.name) nameInput.value = idea.name;

        const descriptionInput = document.getElementById('ach-description');
        if (descriptionInput && !descriptionInput.value && idea.description) descriptionInput.value = idea.description;

        const iconInput = document.getElementById('ach-icon');
        if (iconInput && !iconInput.value && idea.icon) iconInput.value = idea.icon;

        // Populate conditions
        const conditionsContainer = document.getElementById('conditions-container');
        if (conditionsContainer && idea.conditions && Array.isArray(idea.conditions)) {
            conditionsContainer.innerHTML = ''; // Clear existing conditions

            // IMPORTANT: We must use the same options as the form generator
            const conditionOptions = modalHtmlGenerators.achievementForm.conditionOptions;
            if (!conditionOptions) {
                throw new Error("conditionOptions not found. Ensure achievementForm modal has been initialized.");
            }

            idea.conditions.forEach(cond => {
                // This logic is now aligned with `renderConditionBlock` from the form generator
                const conditionDiv = el('div', { class: 'condition-block flex items-center gap-2 p-2 border rounded-md bg-gray-50' }, [
                    el('div', { class: 'flex-grow' }, [
                        el('select', { class: 'ach-condition-type w-full form-element-ink' },
                            [el('option', { value: '', textContent: '---選取條件類型---' })].concat(
                                conditionOptions.map(group =>
                                    el('optgroup', { label: group.label },
                                        group.options.map(opt => el('option', { value: opt.value, textContent: opt.text }))
                                    )
                                )
                            )
                        )
                    ]),
                    el('div', { class: 'flex-grow' }, [
                        el('input', { type: 'number', class: 'ach-condition-value w-full form-element-ink', placeholder: '條件值' })
                    ]),
                    el('button', { type: 'button', class: 'remove-condition-btn btn-danger-outline text-xl font-bold w-8 h-8 flex items-center justify-center', textContent: '×' })
                ]);

                const typeSelect = conditionDiv.querySelector('.ach-condition-type');
                const valueInput = conditionDiv.querySelector('.ach-condition-value');
                const typesWithoutValue = ['weekly_progress'];

                if (cond.type) {
                    typeSelect.value = cond.type;
                }

                // Only set value if the type is not one that should be valueless
                if (cond.value && !typesWithoutValue.includes(cond.type)) {
                    valueInput.value = cond.value;
                }

                // Set initial visibility based on the type
                if (typesWithoutValue.includes(cond.type)) {
                    valueInput.style.display = 'none';
                    valueInput.value = ''; // Ensure value is cleared
                } else {
                    valueInput.style.display = '';
                }
                
                conditionsContainer.appendChild(conditionDiv);
            });
        }

    } catch (error) {
        console.error("Error generating achievement idea:", error);
        if (error instanceof SyntaxError) {
            errorEl.textContent = 'AI 發想失敗：AI 未能回傳有效的 JSON 格式。';
        } else {
            errorEl.textContent = `AI 發想失敗：${error.message}`;
        }
    } finally {
        aiButton.disabled = false;
        aiButton.innerHTML = originalText;
    }
}


        async function renderSystemSettings() {
            const container = document.getElementById('teacher-main-content');
            let panel = document.getElementById('tab-panel-system-settings');

            if (!panel) {
                panel = el('div', { id: 'tab-panel-system-settings' });
                container.appendChild(panel);
            }
            
            // Fetch the current settings to display
            const settingsDoc = await getDoc(doc(db, "settings", "api_keys"));
            const currentSettings = settingsDoc.exists() ? settingsDoc.data() : {};
            const currentApiKey = currentSettings.gemini || "";
            const currentModel = currentSettings.model || "gemini-1.5-flash";

            const settingsHtml = el('div', { class: 'card max-w-2xl mx-auto' }, [
                el('h2', { class: 'text-2xl font-bold mb-6 text-gray-800 font-rounded', textContent: '系統設定' }),
                el('div', { class: 'space-y-6' }, [
                    el('div', {}, [
                        el('label', { for: 'gemini-api-key-input', class: 'font-bold text-sm text-gray-600', textContent: 'Gemini API 金鑰' }),
                        el('input', { type: 'text', id: 'gemini-api-key-input', class: 'w-full form-element-ink mt-1', value: currentApiKey, placeholder: '請在此貼上您的 Gemini API 金鑰' }),
                        el('p', { class: 'text-xs text-gray-500 mt-2', textContent: '此金鑰將被安全地儲存在您的 Firestore 資料庫中。' })
                    ]),
                    el('div', {}, [
                        el('label', { for: 'gemini-model-input', class: 'font-bold text-sm text-gray-600', textContent: 'Gemini AI 模型' }),
                        el('input', { type: 'text', id: 'gemini-model-input', class: 'w-full form-element-ink mt-1', value: currentModel, placeholder: '例如：gemini-1.5-flash' }),
                         el('p', { class: 'text-xs text-gray-500 mt-2', textContent: '請輸入您希望使用的 Gemini 模型名稱。' })
                    ])
                ]),
                el('p', { id: 'settings-feedback', class: 'text-sm h-4 mt-4' }),
                el('div', { class: 'flex justify-end mt-6' }, [
                    el('button', { id: 'save-api-key-btn', class: 'btn-primary py-2 px-6 font-bold', textContent: '儲存設定' })
                ])
            ]);

            panel.innerHTML = '';
            panel.appendChild(settingsHtml);
        }

        async function handleSaveApiKey() {
            const keyInput = document.getElementById('gemini-api-key-input');
            const modelInput = document.getElementById('gemini-model-input');
            const feedbackEl = document.getElementById('settings-feedback');
            
            const newApiKey = keyInput.value.trim();
            const newModel = modelInput.value.trim();

            if (!newApiKey || !newModel) {
                feedbackEl.textContent = '金鑰和模型名稱皆不可為空。';
                feedbackEl.className = 'text-red-500 text-sm h-4 mt-4';
                return;
            }

            showLoading('儲存中...');
            try {
                const docRef = doc(db, "settings", "api_keys");
                await setDoc(docRef, { gemini: newApiKey, model: newModel }, { merge: true });

                // Update the state immediately
                appState.geminiApiKey = newApiKey;
                appState.geminiModel = newModel;

                feedbackEl.textContent = '設定已成功儲存！';
                feedbackEl.className = 'text-green-600 text-sm h-4 mt-4';

            } catch (error) {
                console.error("Error saving API key:", error);
                feedbackEl.textContent = `儲存失敗: ${error.message}`;
                feedbackEl.className = 'text-red-500 text-sm h-4 mt-4';
            } finally {
                hideLoading();
            }
        }
