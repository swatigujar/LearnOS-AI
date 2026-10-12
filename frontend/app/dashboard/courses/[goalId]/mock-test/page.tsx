"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/firebase";

type SavedSyllabus = {
  modules?: {
    module_id: string;
    title: string;
    topics?: { topic_id: string; title: string; description: string }[];
  }[];
};

type SavedTopic = {
  id: string;
  title: string;
  description: string;
  moduleTitle: string;
};

type DemoQuestion = {
  id: string;
  prompt: string;
  options: string[];
  answer: number;
  explanation: string;
};

type QuizQuestion = { id: string; prompt: string; options: string[]; answer?: number; explanation?: string };
type QuestionBankStatus = "checking" | "missing" | "pending" | "ready" | "failed" | "budget_blocked" | "uncertain" | "unavailable";
type SavedQuestionBank = { status: QuestionBankStatus; questions: QuizQuestion[] };
type SubmittedBankResult = {
  total: number; correct: number; incorrect: number; unanswered: number; percentage: number;
  questions: { questionId: string; prompt: string; options: string[]; selectedIndex: number | null; correctIndex: number; explanation: string; correct: boolean }[];
};

const pythonFundamentalsDemo: DemoQuestion[] = [
  {
    id: "python-variable-assignment",
    prompt: "Which line assigns the value 12 to a variable named count in Python?",
    options: ["count == 12", "count = 12", "12 = count", "let count = 12"],
    answer: 1,
    explanation: "Python uses a single equals sign (=) to assign a value to a variable.",
  },
  {
    id: "python-basic-type",
    prompt: "What is the type of the value 3.5 in Python?",
    options: ["int", "str", "float", "bool"],
    answer: 2,
    explanation: "A number with a fractional part, such as 3.5, is a float in Python.",
  },
  { id: "python-assignment-comparison", prompt: "Which operator checks whether two Python values are equal?", options: ["=", "==", ":=", "=>"], answer: 1, explanation: "A single equals sign assigns a value; two equals signs compare values for equality." },
  { id: "python-string-type", prompt: "What type of value does the literal `\"hello\"` represent in Python?", options: ["int", "bool", "str", "float"], answer: 2, explanation: "Text in quotes is a string, represented by the `str` type in Python." },
  { id: "python-boolean-literal", prompt: "Which pair contains Python's Boolean literals?", options: ["true and false", "True and False", "1 and 0 only", "yes and no"], answer: 1, explanation: "Python spells its Boolean literals with initial capitals: `True` and `False`." },
  { id: "python-list-value", prompt: "Which expression creates a Python list containing 2 and 4?", options: ["(2, 4)", "{2, 4}", "[2, 4]", "<2, 4>"], answer: 2, explanation: "Square brackets create a list in Python." },
];

const pythonVariablesDemo: DemoQuestion[] = [
  pythonFundamentalsDemo[0],
  { id: "python-variable-reassignment", prompt: "After `count = 2`, which statement changes `count` to 3?", options: ["count == 3", "count = 3", "3 = count", "count :=: 3"], answer: 1, explanation: "Assignment with `=` stores a new value in the variable." },
  { id: "python-variable-name", prompt: "Which is a valid simple Python variable name?", options: ["2score", "student-name", "student_name", "class"], answer: 2, explanation: "A variable name may use underscores and cannot start with a digit or use a reserved keyword." },
  { id: "python-variable-value", prompt: "What value does `score` refer to after `score = 8`?", options: ["The text 'score'", "The integer value 8", "The comparison result", "No value because variables need a type declaration"], answer: 1, explanation: "The assignment binds the name `score` to the integer value 8." },
  { id: "python-variable-update", prompt: "What is the value of `total` after `total = 4; total = total + 3`?", options: ["4", "3", "7", "43"], answer: 2, explanation: "The second assignment reads the old value 4, adds 3, then stores 7." },
  { id: "python-variable-case", prompt: "In Python, are `count` and `Count` the same variable name?", options: ["Yes, names ignore capitalization", "No, Python names are case-sensitive", "Only inside functions", "Only for numbers"], answer: 1, explanation: "Python is case-sensitive, so `count` and `Count` are distinct names." },
];

const pythonDataTypesDemo: DemoQuestion[] = [
  pythonFundamentalsDemo[1],
  pythonFundamentalsDemo[3],
  pythonFundamentalsDemo[4],
  pythonFundamentalsDemo[5],
  { id: "python-int-type", prompt: "What is the type of the Python value `7`?", options: ["int", "float", "str", "bool"], answer: 0, explanation: "A whole-number literal such as 7 has the `int` type." },
  { id: "python-int-float-distinction", prompt: "Which value is a Python float?", options: ["9", "9.0", "\"9\"", "False"], answer: 1, explanation: "A numeric value with a decimal point, such as 9.0, is a float." },
];

const typeScriptTypesDemo: DemoQuestion[] = [
  {
    id: "typescript-type-annotation",
    prompt: "What does the annotation `: number` indicate in `let score: number = 10`?",
    options: [
      "The variable can only hold numeric values",
      "The variable is available only inside a function",
      "The value is converted to text",
      "The variable cannot be reassigned",
    ],
    answer: 0,
    explanation: "The `number` annotation tells TypeScript to check that score is used as a number.",
  },
  { id: "typescript-boolean-type", prompt: "Which annotation is for a value that stores `true` or `false`?", options: ["boolean", "bool", "truth", "BooleanOnly"], answer: 0, explanation: "TypeScript uses the lowercase `boolean` type for true/false values." },
  { id: "typescript-string-type", prompt: "Which annotation gives `name` the TypeScript string type?", options: ["let name: text", "let name: string", "let name: char", "let name: StringOnly"], answer: 1, explanation: "The primitive text type in TypeScript is written `string` in lowercase." },
  { id: "typescript-union-type", prompt: "What does `string | number` mean as a TypeScript type?", options: ["The value must be both types", "The value may be a string or a number", "The value is converted to a number", "The types are concatenated"], answer: 1, explanation: "A union type uses `|` to allow a value to match either listed type." },
  { id: "typescript-inference", prompt: "If `let count = 3` has no explicit annotation, what does TypeScript generally infer?", options: ["string", "number", "boolean", "unknown only"], answer: 1, explanation: "TypeScript infers a type from the initializer, so the numeric value gives `count` the number type." },
  { id: "typescript-no-conversion", prompt: "Does `let amount: number = 5` convert a string such as `\"5\"` into a number?", options: ["Yes, every annotation converts values", "No, the annotation checks the type; it does not convert the value", "Only when `let` is changed to `const`", "Yes, but only in a browser"], answer: 1, explanation: "Type annotations describe and check types; they do not perform runtime conversion." },
];

const typeScriptInterfacesDemo: DemoQuestion[] = [
  { id: "typescript-optional-property", prompt: "In a TypeScript type or interface, what does `nickname?: string` mean?", options: ["nickname must always be a string", "nickname is optional, and if present it must be a string", "nickname is a private property", "nickname is a function that returns a string"], answer: 1, explanation: "The question mark marks the property as optional; its value must still match the declared string type when present." },
  { id: "typescript-interface-shape", prompt: "What does `interface User { name: string }` primarily describe?", options: ["A runtime object created automatically", "The expected shape of values typed as User", "A function that prints a name", "A database table"], answer: 1, explanation: "An interface describes the property names and types an object should have when checked as that interface." },
  { id: "typescript-interface-property", prompt: "If `User` has a required `name: string`, which value satisfies it?", options: ["{}", "{ name: \"Ari\" }", "{ name: 4 }", "{ title: \"Ari\" }"], answer: 1, explanation: "The object includes the required `name` property with a string value." },
  { id: "typescript-optional-absence", prompt: "For `interface User { nickname?: string }`, which object is valid?", options: ["{}", "{ nickname: 7 }", "{ nickname: false }", "{ nickname: [] }"], answer: 0, explanation: "An optional property may be absent. If present, it must have the declared type." },
  { id: "typescript-optional-check", prompt: "Why should code check an optional `nickname` before using it as a string?", options: ["It may be undefined when absent", "It is always a number", "Optional properties cannot be read", "It is converted to a function"], answer: 0, explanation: "An optional property may be missing, so its value can be undefined." },
  { id: "typescript-implements", prompt: "What does `class Student implements Learner` require at compile time?", options: ["Student must match the members required by Learner", "Learner is instantiated automatically", "Student inherits runtime fields from Learner", "All Learner properties become optional"], answer: 0, explanation: "`implements` asks TypeScript to check that the class provides the required interface shape." },
];

const javaFundamentalsDemo: DemoQuestion[] = [
  {
    id: "java-primitive-type",
    prompt: "Which Java primitive type is commonly used to store a whole number such as 42?",
    options: ["String", "int", "Integer", "Scanner"],
    answer: 1,
    explanation: "int is a Java primitive type for whole numbers. Integer is its wrapper class, while String and Scanner are reference types.",
  },
  {
    id: "java-variable-declaration",
    prompt: "Which statement declares an int variable named count and assigns it 5?",
    options: ["count := 5;", "int count = 5;", "let count = 5;", "int = count(5);"],
    answer: 1,
    explanation: "A Java variable declaration gives the type first, then the variable name, followed by an assignment when needed.",
  },
  {
    id: "java-narrowing-cast",
    prompt: "Which expression explicitly casts a double variable named price to int in Java?",
    options: ["price.toInt()", "price as int", "(int) price", "int(price)"],
    answer: 2,
    explanation: "Java uses a cast such as (int) value for an explicit narrowing conversion. Converting a double to int drops the fractional part.",
  },
  { id: "java-double-primitive", prompt: "Which Java primitive type is designed for a decimal value with double precision?", options: ["double", "String", "Scanner", "Integer"], answer: 0, explanation: "`double` is a primitive floating-point type; `String` and `Scanner` are reference types." },
  { id: "java-boolean-primitive", prompt: "Which declaration uses Java's primitive type for a true/false value?", options: ["boolean ready = true;", "Boolean ready = \"true\";", "bool ready = true;", "String ready = true;"], answer: 0, explanation: "Java's primitive Boolean type is spelled `boolean` and stores `true` or `false`." },
  { id: "java-widening-cast", prompt: "Which conversion from `int count` to `double` is normally allowed by widening?", options: ["double total = count;", "int total = (double) count;", "double total = count.toDouble();", "double total = (String) count;"], answer: 0, explanation: "An int-to-double conversion is a widening primitive conversion and can happen implicitly." },
  { id: "java-cast-truncates", prompt: "What value results from `(int) 6.9` in Java?", options: ["7", "6", "6.9", "The code cannot compile"], answer: 1, explanation: "Casting a positive double to int truncates the fractional part; it does not round." },
  { id: "java-char-primitive", prompt: "Which declaration stores a single Java character using a primitive type?", options: ["char initial = 'L';", "String initial = 'L';", "character initial = 'L';", "byte initial = \"L\";"], answer: 0, explanation: "Java's primitive `char` type stores one character value written with single quotes." },
];

const javaVariablesDemo: DemoQuestion[] = [
  javaFundamentalsDemo[1],
  { id: "java-variable-reassignment", prompt: "After `int count = 2;`, which statement assigns 3 to the same variable?", options: ["int count == 3;", "count = 3;", "3 = count;", "count := 3;"], answer: 1, explanation: "Once declared, a variable is reassigned with its name, `=`, and a compatible value." },
  { id: "java-variable-initialization", prompt: "What does `int score = 10;` do?", options: ["Declares an int variable and initializes it to 10", "Creates a method called score", "Converts 10 to text", "Declares a class"], answer: 0, explanation: "The statement declares a local variable named score and gives it the initial value 10." },
  { id: "java-final-variable", prompt: "After `final int limit = 5;`, what happens if code tries `limit = 6;`?", options: ["The value changes normally", "The reassignment is rejected by the compiler", "limit becomes a String", "The program silently ignores the line"], answer: 1, explanation: "A final local variable cannot be assigned again after initialization." },
  { id: "java-variable-inference", prompt: "In Java, which part identifies the type in `double temperature = 21.5;`?", options: ["temperature", "=", "double", "21.5"], answer: 2, explanation: "Java variable declarations state the type explicitly before the variable name." },
  { id: "java-variable-semicolon", prompt: "What punctuation ends a Java local variable declaration statement?", options: ["A semicolon", "A colon", "A comma", "No punctuation is used"], answer: 0, explanation: "A Java statement such as a variable declaration ends with a semicolon." },
];

const javaPrimitiveTypesDemo: DemoQuestion[] = [
  javaFundamentalsDemo[0], javaFundamentalsDemo[3], javaFundamentalsDemo[4], javaFundamentalsDemo[7],
  { id: "java-byte-primitive", prompt: "Which of these is a Java primitive type?", options: ["byte", "String", "Scanner", "ArrayList"], answer: 0, explanation: "`byte` is one of Java's eight primitive types; the other choices are reference types." },
  { id: "java-long-primitive", prompt: "Which primitive type is commonly used for a whole number that may exceed the int range?", options: ["long", "String", "Integer", "BigNumber"], answer: 0, explanation: "`long` is a 64-bit integral primitive type with a larger range than `int`." },
];

const javaTypeCastingDemo: DemoQuestion[] = [
  javaFundamentalsDemo[2], javaFundamentalsDemo[5], javaFundamentalsDemo[6],
  { id: "java-explicit-cast-form", prompt: "Which syntax explicitly casts a double expression `value` to int in Java?", options: ["value.toInt()", "value as int", "(int) value", "int(value)"], answer: 2, explanation: "Java places the target type in parentheses before the expression for an explicit cast." },
  { id: "java-widening-no-cast", prompt: "Which assignment uses a widening conversion from `int n` to `double d`?", options: ["double d = n;", "int d = n;", "double d = (String) n;", "double d = n.toDouble();"], answer: 0, explanation: "An int can widen to double without an explicit cast because double can represent a wider range of numeric values." },
  { id: "java-narrowing-needs-cast", prompt: "Why does assigning a `double` directly to an `int` usually require a cast?", options: ["It may lose fractional information", "int stores only text", "double is not numeric", "Java forbids numeric assignments"], answer: 0, explanation: "Narrowing from double to int can discard the fractional part, so Java requires an explicit cast." },
];

const javaConditionalBranchingDemo: DemoQuestion[] = [
  { id: "java-if-condition", prompt: "Which condition is valid in a Java `if` statement when `score` is an int?", options: ["if (score >= 60)", "if score >= 60:", "if (score = 60)", "if {score >= 60}"], answer: 0, explanation: "Java places the Boolean condition inside parentheses after `if`; `>=` compares without assigning." },
  { id: "java-if-else", prompt: "When does the `else` branch of an `if`/`else` statement run?", options: ["Whenever the condition is true", "When the condition is false", "Only when the program starts", "After every loop iteration"], answer: 1, explanation: "The `else` branch runs when its paired `if` condition evaluates to false." },
  { id: "java-else-if-order", prompt: "In an `if` / `else if` / `else` chain, what happens after a branch condition is true and its block runs?", options: ["Later branches in that chain are skipped", "Every later branch also runs", "The first condition is checked again", "The program must restart"], answer: 0, explanation: "An if/else-if chain selects the first true branch and skips the remaining branches in that chain." },
  { id: "java-comparison-condition", prompt: "Which expression checks that `temperature` is between 10 and 30 inclusive?", options: ["temperature >= 10 && temperature <= 30", "temperature >= 10 || temperature <= 30", "temperature = 10 && 30", "10 <= temperature <= 30"], answer: 0, explanation: "Both bounds must be true, so Java uses `&&` between the two comparisons." },
  { id: "java-nested-condition", prompt: "What is a nested `if` statement?", options: ["An `if` statement inside another branch", "An `if` statement that runs only in a loop", "A comparison with two equals signs", "A method that returns a Boolean"], answer: 0, explanation: "A nested if is an if statement placed inside another if or else block." },
  { id: "java-boolean-branch", prompt: "Given `boolean ready = false;`, which block runs in `if (ready) { ... } else { ... }`?", options: ["The if block", "The else block", "Both blocks", "Neither block; Java rejects false"], answer: 1, explanation: "Because `ready` is false, the condition fails and the else block runs." },
];

function normalizeTopicText(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

const demoQuestionSets: { coursePattern: RegExp; topicPattern: RegExp; contextPattern?: RegExp; questions: DemoQuestion[] }[] = [
  {
    coursePattern: /\bpython\b/i,
    topicPattern: /\bvariables?\b/i,
    contextPattern: /\b(variables?|assign\w*|initializ\w*|reassign|identifier|scope)\b/i,
    questions: pythonVariablesDemo,
  },
  {
    coursePattern: /\bpython\b/i,
    topicPattern: /\bdata types?\b/i,
    contextPattern: /\b(data type|numeric|integer|float|string|boolean|python type)\b/i,
    questions: pythonDataTypesDemo,
  },
  {
    coursePattern: /\bpython\b/i,
    topicPattern: /\b(syntax and values|python fundamentals|python basics|introduction)\b/i,
    contextPattern: /\b(variable|assignment|values?|data types?|python syntax|numeric|boolean)\b/i,
    questions: pythonFundamentalsDemo,
  },
  {
    coursePattern: /\btypescript\b/i,
    topicPattern: /\b(type annotations?|annotations?|types?|typing|fundamentals|basics|introduction|compiler)\b/i,
    contextPattern: /\b(type annotations?|annotations?|type inference|inference|union types?|primitive types?|compiler checks?)\b/i,
    questions: typeScriptTypesDemo,
  },
  {
    coursePattern: /\btypescript\b/i,
    topicPattern: /\b(interfaces?|optional properties|object types?)\b/i,
    contextPattern: /\b(interface|optional propert|object shape|implements)\b/i,
    questions: typeScriptInterfacesDemo,
  },
  {
    coursePattern: /\bjava\b/i,
    topicPattern: /\bprimitive types? and variables?\b/i,
    questions: javaFundamentalsDemo,
  },
  {
    coursePattern: /\bjava\b/i,
    topicPattern: /\bvariables?\b/i,
    contextPattern: /\b(variables?|declaration|assignment|initializ\w*|reassign|final)\b/i,
    questions: javaVariablesDemo,
  },
  {
    coursePattern: /\bjava\b/i,
    topicPattern: /\bprimitive types?\b/i,
    contextPattern: /\b(primitive|int|double|boolean|char|byte|long)\b/i,
    questions: javaPrimitiveTypesDemo,
  },
  {
    coursePattern: /\bjava\b/i,
    topicPattern: /\btype cast(?:ing)?\b|\bcast(?:ing)? types?\b/i,
    contextPattern: /\b(cast|casting|conversion|narrowing|widening)\b/i,
    questions: javaTypeCastingDemo,
  },
  {
    coursePattern: /\bjava\b/i,
    topicPattern: /\bconditional branching\b/i,
    contextPattern: /\bcontrol flow and modular code\b/i,
    questions: javaConditionalBranchingDemo,
  },
];

function questionsForTopic(courseName: string, topic?: SavedTopic) {
  if (!topic) return [];
  const normalizedCourseName = normalizeTopicText(courseName);
  const topicTitle = normalizeTopicText(topic.title);
  const topicContext = normalizeTopicText(`${topic.title} ${topic.moduleTitle} ${topic.description}`);
  return demoQuestionSets.find((set) => set.coursePattern.test(normalizedCourseName)
    && set.topicPattern.test(topicTitle)
    && (!set.contextPattern || set.contextPattern.test(topicContext)))?.questions ?? [];
}

function scoreDemoTest(questions: QuizQuestion[], answers: Record<string, number>) {
  const answeredCount = questions.filter((question) => answers[question.id] !== undefined).length;
  const correctCount = questions.filter((question) => question.answer !== undefined && answers[question.id] === question.answer).length;
  return {
    totalCount: questions.length,
    answeredCount,
    correctCount,
    incorrectCount: answeredCount - correctCount,
    unansweredCount: questions.length - answeredCount,
    percentage: questions.length ? Math.round((correctCount / questions.length) * 100) : 0,
  };
}

export default function MockTestPage() {
  const params = useParams<{ goalId: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [courseName, setCourseName] = useState("Saved course");
  const [syllabusStatus, setSyllabusStatus] = useState("");
  const [syllabusVersion, setSyllabusVersion] = useState(0);
  const [syllabus, setSyllabus] = useState<SavedSyllabus | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [topicMenuOpen, setTopicMenuOpen] = useState(false);
  const topicMenu = useRef<HTMLDetailsElement>(null);
  const lastSyllabusVersion = useRef<number | null>(null);
  const activeBankKey = useRef("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [testStarted, setTestStarted] = useState(false);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [generatedBanks, setGeneratedBanks] = useState<Record<string, SavedQuestionBank>>({});
  const [submittedBankResult, setSubmittedBankResult] = useState<SubmittedBankResult | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/signin");
  }, [authLoading, router, user]);

  useEffect(() => {
    if (!user || !params.goalId) return;
    let active = true;
    let stopSyllabus: (() => void) | undefined;
    const stopCourse = onSnapshot(doc(db, "users", user.uid, "courses", params.goalId), (snapshot) => {
      stopSyllabus?.();
      stopSyllabus = undefined;
      if (!snapshot.exists()) {
        setError("This saved course could not be found.");
        setLoading(false);
        return;
      }

      const course = snapshot.data();
      setCourseName(course.course_name ?? course.courseName ?? "Saved course");
      setSyllabusStatus(course.syllabusStatus ?? "");
      const nextVersion = typeof course.syllabusVersion === "number" ? course.syllabusVersion : 0;
      if (lastSyllabusVersion.current !== null && lastSyllabusVersion.current !== nextVersion) {
        setTestStarted(false);
        setActiveQuestionIndex(0);
        setAnswers({});
        setSubmitted(false);
        setSubmittedBankResult(null);
      }
      lastSyllabusVersion.current = nextVersion;
      setSyllabusVersion(nextVersion);
      if (course.syllabusStatus === "ready" && typeof course.syllabusVersion === "number" && course.syllabusVersion > 0) {
        stopSyllabus = onSnapshot(doc(db, "users", user.uid, "courses", params.goalId, "syllabus", `v${course.syllabusVersion}`), (saved) => {
          if (!active) return;
          setSyllabus(saved.exists() ? saved.data() as SavedSyllabus : null);
          setLoading(false);
        }, (readError) => {
          if (!active) return;
          setError(readError.message);
          setLoading(false);
        });
      } else {
        setSyllabus(null);
        setLoading(false);
      }
    }, (readError) => {
      if (!active) return;
      setError(readError.message);
      setLoading(false);
    });

    return () => {
      active = false;
      stopCourse();
      stopSyllabus?.();
    };
  }, [params.goalId, user]);

  useEffect(() => {
    function closeTopicMenu(event: PointerEvent) {
      if (topicMenu.current && !topicMenu.current.contains(event.target as Node)) {
        topicMenu.current.open = false;
      }
    }
    document.addEventListener("pointerdown", closeTopicMenu);
    return () => document.removeEventListener("pointerdown", closeTopicMenu);
  }, []);

  const topics = useMemo<SavedTopic[]>(() => (syllabus?.modules ?? []).flatMap((module) =>
    (module.topics ?? []).map((topic) => ({
      id: topic.topic_id,
      title: topic.title,
      description: topic.description,
      moduleTitle: module.title,
    }))
  ), [syllabus]);
  const selectedTopic = topics.find((topic) => topic.id === selectedTopicId) ?? topics[0];
  const staticQuestions = useMemo(() => questionsForTopic(courseName, selectedTopic), [courseName, selectedTopic]);
  const bankCacheKey = selectedTopic ? `${syllabusVersion}:${selectedTopic.id}` : "";
  const selectedBank = bankCacheKey ? generatedBanks[bankCacheKey] : undefined;
  const selectedBankStatus = selectedBank?.status ?? "checking";
  const questions: QuizQuestion[] = staticQuestions.length ? staticQuestions : selectedBank?.questions ?? [];
  const score = scoreDemoTest(questions, answers);
  const currentQuestion = questions[activeQuestionIndex];
  const { answeredCount } = score;
  const isGeneratedBank = staticQuestions.length === 0 && selectedBank?.status === "ready";
  const resultTotal = submittedBankResult?.total ?? score.totalCount;
  const correctCount = submittedBankResult?.correct ?? (submitted ? score.correctCount : 0);
  const incorrectCount = submittedBankResult?.incorrect ?? (submitted ? score.incorrectCount : 0);
  const unansweredCount = submittedBankResult?.unanswered ?? (submitted ? score.unansweredCount : 0);
  const scorePercentage = submittedBankResult?.percentage ?? score.percentage;

  useEffect(() => {
    activeBankKey.current = bankCacheKey;
  }, [bankCacheKey]);

  useEffect(() => {
    if (!user || !params.goalId || !selectedTopic || staticQuestions.length || generatedBanks[bankCacheKey]) return;
    let active = true;
    const currentUser = user;
    const topicId = selectedTopic.id;
    async function loadQuestionBank() {
      try {
        const token = await currentUser.getIdToken();
        const response = await fetch(`/api/mock-test?courseId=${encodeURIComponent(params.goalId)}&topicId=${encodeURIComponent(topicId)}&syllabusVersion=${syllabusVersion}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(25_000),
        });
        if (!response.ok) {
          const failure = await response.json().catch(() => null) as { detail?: unknown } | null;
          throw new Error(typeof failure?.detail === "string" ? failure.detail : "Saved question-bank status is unavailable.");
        }
        const result = await response.json() as { status: QuestionBankStatus; questions?: { questionId: string; prompt: string; options: string[] }[] };
        if (!active) return;
        setGeneratedBanks((current) => ({
          ...current,
          [bankCacheKey]: {
            status: result.status,
            questions: (result.questions ?? []).map((question) => ({ id: question.questionId, prompt: question.prompt, options: question.options })),
          },
        }));
      } catch {
        if (active) setGeneratedBanks((current) => ({ ...current, [bankCacheKey]: { status: "unavailable", questions: [] } }));
      }
    }
    void loadQuestionBank();
    return () => { active = false; };
  }, [bankCacheKey, generatedBanks, params.goalId, selectedTopic, staticQuestions.length, syllabusVersion, user]);

  function resetTest() {
    setTestStarted(false);
    setActiveQuestionIndex(0);
    setAnswers({});
    setSubmitted(false);
    setSubmittedBankResult(null);
    setActionError("");
  }

  function changeTopic(topicId: string) {
    setSelectedTopicId(topicId);
    resetTest();
  }

  async function checkSavedBank() {
    if (!user || !selectedTopic) return;
    const requestBankKey = bankCacheKey;
    setActionError("");
    setGeneratedBanks((current) => ({ ...current, [requestBankKey]: { status: "checking", questions: [] } }));
    try {
      const token = await user.getIdToken();
      const response = await fetch(`/api/mock-test?courseId=${encodeURIComponent(params.goalId)}&topicId=${encodeURIComponent(selectedTopic.id)}&syllabusVersion=${syllabusVersion}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(25_000),
      });
      const result = await response.json().catch(() => null) as { status?: QuestionBankStatus; questions?: { questionId: string; prompt: string; options: string[] }[]; detail?: unknown } | null;
      if (!response.ok || !result?.status) {
        throw new Error(typeof result?.detail === "string" ? result.detail : "Saved question-bank status is unavailable.");
      }
      if (activeBankKey.current === requestBankKey) {
        setGeneratedBanks((current) => ({ ...current, [requestBankKey]: {
          status: result.status!,
          questions: (result.questions ?? []).map((question) => ({ id: question.questionId, prompt: question.prompt, options: question.options })),
        } }));
      }
    } catch (failure) {
      if (activeBankKey.current === requestBankKey) {
        setGeneratedBanks((current) => ({ ...current, [requestBankKey]: { status: "unavailable", questions: [] } }));
        setActionError(failure instanceof Error ? failure.message : "Saved question-bank status is unavailable.");
      }
    }
  }

  async function startTest() {
    if (!selectedTopic) return;
    const requestBankKey = bankCacheKey;
    setActionError("");
    if (staticQuestions.length) {
      setAnswers({});
      setActiveQuestionIndex(0);
      setSubmitted(false);
      setSubmittedBankResult(null);
      setTestStarted(true);
      return;
    }
    if (selectedBank?.status === "ready" && selectedBank.questions.length === 6) {
      setAnswers({});
      setActiveQuestionIndex(0);
      setSubmitted(false);
      setSubmittedBankResult(null);
      setTestStarted(true);
      return;
    }
    if (!user || !["missing", "failed", "budget_blocked", "uncertain"].includes(selectedBankStatus)) return;
    setGeneratedBanks((current) => ({ ...current, [requestBankKey]: { status: "pending", questions: [] } }));
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/mock-test", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "start", courseId: params.goalId, topicId: selectedTopic.id, syllabusVersion, attemptId: crypto.randomUUID() }),
        cache: "no-store", signal: AbortSignal.timeout(145_000),
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { detail?: unknown } | null;
        throw new Error(typeof failure?.detail === "string" ? failure.detail : "Question preparation is unavailable. Check the saved bank status before starting again.");
      }
      const result = await response.json() as { status: QuestionBankStatus; questions?: { questionId: string; prompt: string; options: string[] }[] };
      const bank = {
        status: result.status,
        questions: (result.questions ?? []).map((question) => ({ id: question.questionId, prompt: question.prompt, options: question.options })),
      };
      setGeneratedBanks((current) => ({ ...current, [requestBankKey]: bank }));
      if (activeBankKey.current === requestBankKey && bank.status === "ready" && bank.questions.length === 6) {
        setAnswers({});
        setActiveQuestionIndex(0);
        setSubmitted(false);
        setSubmittedBankResult(null);
        setTestStarted(true);
      }
    } catch (failure) {
      // A lost/failed response is not proof that generation is still running.
      // Mark it unavailable and let the learner explicitly check the saved bank.
      setGeneratedBanks((current) => ({ ...current, [requestBankKey]: { status: "unavailable", questions: [] } }));
      if (activeBankKey.current === requestBankKey) {
        setActionError(failure instanceof Error ? failure.message : "Question preparation is unavailable.");
      }
    }
  }

  async function submitTest() {
    if (!isGeneratedBank || !selectedTopic || !user) {
      setSubmitted(true);
      return;
    }
    setSubmitting(true);
    setActionError("");
    try {
      const token = await user.getIdToken();
      const response = await fetch("/api/mock-test", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "submit", courseId: params.goalId, topicId: selectedTopic.id, syllabusVersion, answers }),
        cache: "no-store", signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) throw new Error("Your answers could not be scored. They remain on this page; submit again when available.");
      setSubmittedBankResult(await response.json() as SubmittedBankResult);
      setSubmitted(true);
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "Your answers could not be scored.");
    } finally {
      setSubmitting(false);
    }
  }

  if (authLoading || !user || loading) {
    return <main className="flex min-h-screen items-center justify-center bg-[#f6f5ef] text-sm text-[#68736d]">Loading your saved course...</main>;
  }

  return (
    <main className="min-h-screen bg-[#f6f5ef] px-5 py-8 text-[#1b302b] sm:px-8 sm:py-10">
      <div className="mx-auto max-w-4xl">
        <Link className="text-sm font-semibold text-[#586761] hover:text-[#1b302b] focus-visible:outline-2 focus-visible:outline-[#1b6657]" href={`/dashboard/courses/${params.goalId}`}>
          ← Back to course
        </Link>
        <header className="mt-6 border-b border-[#e0e2d9] pb-5">
          <p className="text-xs font-bold uppercase tracking-wide text-[#d16445]">Practice</p>
          <h1 className="mt-2 text-2xl font-semibold">Mock Test</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#68736d]">Choose a saved topic, answer each question, and submit to see your results.</p>
        </header>

        {error ? (
          <section className="mt-6 rounded-lg border border-red-200 bg-white p-5" role="alert">
            <h2 className="font-semibold">Course unavailable</h2>
            <p className="mt-2 text-sm text-[#68736d]">{error}</p>
          </section>
        ) : (
          <>
            <section aria-labelledby="test-setup-heading" className="mt-6 rounded-lg border border-[#e0e2d9] bg-white p-5 sm:p-6">
              <h2 className="text-lg font-semibold" id="test-setup-heading">Test setup</h2>
              <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Course</dt>
                  <dd className="mt-1 break-words text-sm">{courseName}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Question count</dt>
                  <dd className="mt-1 text-sm">
                    {questions.length ? `${questions.length} ${staticQuestions.length ? "fixed demo" : "saved"} questions available` :
                      selectedBankStatus === "checking" ? "Checking saved question bank…" :
                      selectedBankStatus === "missing" ? "6 questions can be prepared when you start" :
                      selectedBankStatus === "pending" ? "Question bank preparation is pending" :
                      selectedBankStatus === "budget_blocked" ? "Unavailable: AI usage budget limit reached" :
                      selectedBankStatus === "failed" ? "Unavailable: question bank needs an explicit retry" :
                      selectedBankStatus === "uncertain" ? "Previous request outcome is uncertain; check or retry explicitly" :
                      selectedBankStatus === "unavailable" ? "Unavailable: question bank status could not be loaded" : "Select a topic to check its saved question bank"}
                  </dd>
                </div>
              </dl>

              {topics.length > 0 ? (
                <div className="mt-5">
                  <p className="block text-sm font-medium" id="mock-test-topic-label">Lesson or topic</p>
                  <details
                    className="relative z-20 mt-1.5"
                    id="mock-test-topic"
                    onKeyDown={(event) => {
                      if (event.key === "Escape" && topicMenu.current?.open) {
                        topicMenu.current.open = false;
                        topicMenu.current.querySelector("summary")?.focus();
                      }
                    }}
                    onToggle={(event) => setTopicMenuOpen(event.currentTarget.open)}
                    ref={topicMenu}
                  >
                    <summary aria-controls="mock-test-topic-options" aria-expanded={topicMenuOpen} aria-labelledby="mock-test-topic-label mock-test-topic-selected" className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md border border-[#d9ddd5] bg-white px-3 py-2.5 text-sm font-medium outline-none hover:border-[#89938c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] [&::-webkit-details-marker]:hidden">
                      <span className="min-w-0 break-words" id="mock-test-topic-selected">{selectedTopic ? `${selectedTopic.moduleTitle}: ${selectedTopic.title}` : "Choose a lesson or topic"}</span>
                      <ChevronDown aria-hidden="true" className={`shrink-0 transition-transform ${topicMenuOpen ? "rotate-180" : ""}`} size={16} />
                    </summary>
                    <div aria-label="Available lesson topics" className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-md border border-[#d9ddd5] bg-white p-1 shadow-lg" id="mock-test-topic-options">
                      {topics.map((topic) => (
                        <button
                          aria-pressed={selectedTopic?.id === topic.id}
                          className={`block min-h-11 w-full rounded px-3 py-2 text-left text-sm leading-5 focus-visible:outline-2 focus-visible:outline-[#1b6657] ${selectedTopic?.id === topic.id ? "bg-[#eaf4ef] font-semibold text-[#1b6657]" : "text-[#34423c] hover:bg-[#f6f8f5]"}`}
                          key={topic.id}
                          onClick={() => {
                            changeTopic(topic.id);
                            if (topicMenu.current) topicMenu.current.open = false;
                          }}
                          type="button"
                        >
                          <span className="block break-words">{topic.moduleTitle}: {topic.title}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                  {selectedTopic && <p className="mt-2 text-sm leading-6 text-[#68736d]">{selectedTopic.description}</p>}
                </div>
              ) : (
                <p className="mt-5 rounded-md border border-[#e0e2d9] bg-[#f6f5ef] px-3 py-2.5 text-sm text-[#586761]">
                  {syllabusStatus === "ready" ? "No lessons are available in the saved syllabus." : "A saved syllabus is not available for this course yet."}
                </p>
              )}

              <div className="mt-5 border-t border-[#edf0e9] pt-4">
                <h3 className="text-sm font-semibold">Instructions</h3>
                <p className="mt-2 text-sm leading-6 text-[#586761]">One answer per question. Submit to see your score and explanations.</p>
                {!testStarted && (
                  <button
                    className="mt-5 rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#28473f] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={!staticQuestions.length && !(selectedBank?.status === "ready" && selectedBank.questions.length === 6) && !["missing", "failed", "budget_blocked", "uncertain"].includes(selectedBankStatus)}
                    onClick={() => void startTest()}
                    type="button"
                  >
                    {selectedBankStatus === "checking" ? "Checking saved bank…" : selectedBankStatus === "pending" ? "Question bank pending…" : ["failed", "budget_blocked", "uncertain"].includes(selectedBankStatus) ? "Try again explicitly" : "Start Test"}
                  </button>
                )}
                {actionError && <p className="mt-3 text-sm text-red-700" role="alert">{actionError}</p>}
                {!staticQuestions.length && selectedBank?.status === "budget_blocked" && <p className="mt-3 text-sm text-[#8a4b20]" role="status">Question generation is blocked by the configured AI usage budget. This topic cannot be started.</p>}
                {!staticQuestions.length && selectedBank?.status === "failed" && <p className="mt-3 text-sm text-[#8a4b20]" role="status">This topic’s one-time question-bank attempt did not produce a valid saved set. It will not be retried automatically.</p>}
                {!staticQuestions.length && selectedBank?.status === "pending" && <p className="mt-3 text-sm text-[#68736d]" role="status">A preparation request is already recorded. Reload later to check whether its saved bank is ready.</p>}
                {!staticQuestions.length && selectedBank?.status === "uncertain" && <p className="mt-3 text-sm text-[#8a4b20]" role="status">The previous provider request timed out or had an uncertain outcome. No automatic retry was made. An explicit retry may result in another provider charge.</p>}
                {!staticQuestions.length && selectedBank?.status === "unavailable" && <p className="mt-3 text-sm text-[#8a4b20]" role="status">The saved question-bank status could not be checked. Reload the page to check again; no questions were generated by this check.</p>}
                {!staticQuestions.length && selectedBank?.status === "unavailable" && <button className="mt-3 rounded-md border border-[#d9ddd5] px-3 py-2 text-sm font-semibold transition hover:bg-[#f6f8f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" disabled={selectedBankStatus === "checking"} onClick={() => void checkSavedBank()} type="button">Check saved bank</button>}
              </div>
            </section>

            {testStarted && !submitted && currentQuestion && (
              <section aria-labelledby="demo-test-heading" className="mt-5 rounded-lg border border-[#e0e2d9] bg-white p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold" id="demo-test-heading">{isGeneratedBank ? "Saved topic question bank" : "Fixed demo questions — not personalized"}</h2>
                  <p className="text-sm text-[#68736d]">Question {activeQuestionIndex + 1} of {questions.length} · {answeredCount} answered</p>
                </div>
                <fieldset className="mt-5">
                  <legend className="text-base font-semibold leading-6">{currentQuestion.prompt}</legend>
                  <div className="mt-4 space-y-2">
                    {currentQuestion.options.map((option, optionIndex) => (
                      <label className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm leading-6 transition-colors ${answers[currentQuestion.id] === optionIndex ? "border-[#1b6657] bg-[#eaf4ef]" : "border-[#e0e2d9] hover:bg-[#f6f8f5]"}`} key={option}>
                        <input checked={answers[currentQuestion.id] === optionIndex} className="mt-1 accent-[#1b6657]" name={`answer-${currentQuestion.id}`} onChange={() => setAnswers((current) => ({ ...current, [currentQuestion.id]: optionIndex }))} type="radio" />
                        <span>{option}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#edf0e9] pt-4">
                  <button className="rounded-md border border-[#d9ddd5] px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" disabled={activeQuestionIndex === 0} onClick={() => setActiveQuestionIndex((index) => index - 1)} type="button">Previous</button>
                  {activeQuestionIndex < questions.length - 1 ? (
                    <button className="rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white" onClick={() => setActiveQuestionIndex((index) => index + 1)} type="button">Next</button>
                  ) : (
                    <div className="text-right">
                      <button className="rounded-md bg-[#1b302b] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#28473f] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657] disabled:cursor-wait disabled:opacity-60" disabled={submitting} onClick={() => void submitTest()} type="button">{submitting ? "Scoring…" : "Submit Test"}</button>
                      {answeredCount !== questions.length && <p className="mt-2 text-xs text-[#68736d]" role="status">You can submit now; unanswered questions will be shown in your results.</p>}
                    </div>
                  )}
                </div>
              </section>
            )}

            {submitted && (
              <section aria-labelledby="test-results-heading" className="mt-5 rounded-lg border border-[#dce9df] bg-white p-5 sm:p-6">
                <p className="text-xs font-bold uppercase tracking-wide text-[#1b6657]">{isGeneratedBank ? "Topic mock test results" : "Demo test results"}</p>
                <h2 className="mt-1 text-xl font-semibold" id="test-results-heading">Score: {scorePercentage}%</h2>
                <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Total</dt><dd className="mt-1 text-lg font-semibold">{resultTotal}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Correct</dt><dd className="mt-1 text-lg font-semibold text-[#31553d]">{correctCount}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Incorrect</dt><dd className="mt-1 text-lg font-semibold text-[#9b3b2b]">{incorrectCount}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Unanswered</dt><dd className="mt-1 text-lg font-semibold">{unansweredCount}</dd></div>
                  <div><dt className="text-xs font-semibold uppercase tracking-wide text-[#89938c]">Percentage</dt><dd className="mt-1 text-lg font-semibold">{scorePercentage}%</dd></div>
                </dl>
                <ol className="mt-5 space-y-4 border-t border-[#edf0e9] pt-4">
                  {questions.map((question, index) => {
                    const review = submittedBankResult?.questions[index];
                    const selectedIndex = review ? review.selectedIndex : answers[question.id] ?? null;
                    const correctIndex = review?.correctIndex ?? question.answer;
                    return (
                      <li className="rounded-md bg-[#f6f8f5] p-4" key={question.id}>
                        <h3 className="text-sm font-semibold">{index + 1}. {question.prompt}</h3>
                        <p className="mt-2 text-sm text-[#586761]">Your answer: {selectedIndex === null ? "Not answered" : question.options[selectedIndex]}</p>
                        <p className="mt-1 text-sm font-medium text-[#31553d]">Correct answer: {correctIndex === undefined ? "Unavailable" : question.options[correctIndex]}</p>
                        <p className="mt-2 text-sm leading-6 text-[#586761]">{review?.explanation ?? question.explanation}</p>
                      </li>
                    );
                  })}
                </ol>
                <button className="mt-5 rounded-md border border-[#d9ddd5] px-4 py-2.5 text-sm font-semibold transition hover:bg-[#f6f8f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1b6657]" onClick={resetTest} type="button">Retake Test</button>
              </section>
            )}

            {!questions.length && (
              <section aria-labelledby="question-bank-heading" className="mt-5 rounded-lg border border-[#e0e2d9] bg-white p-5 sm:p-6">
                <h2 className="font-semibold" id="question-bank-heading">{selectedBankStatus === "missing" ? "No saved question bank yet" : selectedBankStatus === "pending" ? "Question bank preparation pending" : selectedBankStatus === "checking" ? "Checking saved question bank" : "Question bank unavailable"}</h2>
                <p className="mt-2 text-sm leading-6 text-[#586761]">
                  {selectedBankStatus === "missing"
                    ? "Starting prepares and saves six questions once. Opening this page or changing topics does not generate questions."
                    : selectedBankStatus === "pending"
                      ? "A preparation claim is already saved. Reload later to check whether the question bank is ready; this request will not be repeated automatically."
                      : selectedBankStatus === "budget_blocked"
                        ? "The configured AI usage budget blocks preparing this topic. No question bank is available to start."
                        : selectedBankStatus === "failed"
                          ? "The last preparation attempt did not produce a valid bank. No automatic retry occurred; use Try again explicitly if you want another one-time attempt."
                          : selectedBankStatus === "uncertain"
                            ? "The previous request outcome is uncertain. No automatic retry occurred; an explicit retry may incur another provider charge."
                          : selectedBankStatus === "checking"
                            ? "Checking whether a saved question bank is available. This check does not generate questions."
                      : "A saved question bank could not be loaded. No questions will be invented."}
                </p>
              </section>
            )}

            <section aria-labelledby="coming-soon-heading" className="mt-5 rounded-lg border border-[#e0e2d9] bg-white p-5 sm:p-6">
              <h2 className="font-semibold" id="coming-soon-heading">Coming Soon</h2>
              <ul className="mt-3 flex flex-wrap gap-2 text-sm text-[#68736d]">
                <li className="rounded-full bg-[#f0f1ec] px-3 py-1.5">Timed mock tests · Coming Soon</li>
                <li className="rounded-full bg-[#f0f1ec] px-3 py-1.5">Performance analytics · Coming Soon</li>
                <li className="rounded-full bg-[#f0f1ec] px-3 py-1.5">Adaptive difficulty · Coming Soon</li>
                <li className="rounded-full bg-[#f0f1ec] px-3 py-1.5">Larger question banks · Coming Soon</li>
              </ul>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
