import unittest
from copy import deepcopy
from io import StringIO
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services import ai_usage
from app.services.ai_provider import AIProviderError


class Snapshot:
    def __init__(self, data):
        self._data = data
        self.exists = data is not None

    def to_dict(self):
        return deepcopy(self._data)


class Reference:
    def __init__(self, database, path):
        self.database = database
        self.path = path
        self.id = path.split("/")[-1]

    def get(self, transaction=None):
        return Snapshot(self.database.docs.get(self.path))


class Transaction:
    _read_only = False
    _max_attempts = 1
    _id = b"mock-usage-transaction"

    def __init__(self, database):
        self.database = database
        self.writes = []

    def _begin(self, retry_id=None):
        pass

    def _rollback(self):
        self.writes = []

    def _clean_up(self):
        self.writes = []

    def _commit(self):
        for operation, reference, values, merge in self.writes:
            if operation == "create" and reference.path in self.database.docs:
                raise RuntimeError("duplicate document")
            current = self.database.docs.get(reference.path, {}) if merge else {}
            self.database.docs[reference.path] = {**current, **deepcopy(values)}
        self.writes = []

    def create(self, reference, values):
        self.writes.append(("create", reference, values, False))

    def set(self, reference, values, merge=False):
        self.writes.append(("set", reference, values, merge))


class Database:
    def __init__(self):
        self.docs = {}

    def document(self, path):
        return Reference(self, path)

    def transaction(self):
        return Transaction(self)


class AIUsageLimitTests(unittest.TestCase):
    def test_backend_startup_enables_chat_and_live_usage_console_logs(self):
        from app import main

        self.assertIs(main.usage_logger, ai_usage.logger)
        stream = StringIO()
        handler = main.usage_logger.handlers[0]
        with patch.object(handler, "stream", stream):
            ai_usage._log_usage(
                request_id="chat-log", feature="tutor", model="chat-model",
                status="success", duration_ms=1,
                result=SimpleNamespace(usage={"input_tokens": 10, "output_tokens": 5}),
            )
            ai_usage.log_live_usage(
                request_id="live-log", model="live-model", session_reserved_cost_usd=2,
                usage={"input_tokens": 0, "output_tokens": 0, "thinking_tokens": 0,
                       "total_tokens": 0, "prompt_tokens_details": [], "response_tokens_details": []},
            )
        output = stream.getvalue()
        self.assertIn("GEMINI_USAGE", output)
        self.assertIn("GEMINI_LIVE_USAGE", output)
        self.assertIn("'input_tokens': 10", output)
        self.assertIn("'output_tokens': 5", output)

    def test_live_token_log_does_not_double_count_session_reserve(self):
        with patch.object(ai_usage, "USD_TO_INR_RATE", "90"), \
                self.assertLogs(ai_usage.logger, level="INFO") as captured:
            ai_usage._log_usage(
                request_id="live-token", feature="tutor_live_session", model="live-model",
                status="success", duration_ms=1, reserved_cost_usd=2.01, fixed_cost_usd=2,
            )
        output = captured.records[0].getMessage()
        self.assertIn("'reserved_estimated_cost_usd': 2.01", output)
        self.assertIn("'reserved_estimated_cost_inr': 180.9", output)
        self.assertIn("'token_usage_available': False", output)
        self.assertIn("'input_tokens': None", output)

    def setUp(self):
        self.database = Database()
        self.firestore = patch.object(ai_usage, "get_firestore_client", return_value=self.database)
        self.firestore.start()
        self.addCleanup(self.firestore.stop)

    def call(self, request_id, invoke, *, output_limit=10):
        return ai_usage.run_tracked_provider_call(
            feature="tutor",
            request_id=request_id,
            model="gemini-3.8-flash",
            prompt_content="private learner question",
            invoke=invoke,
            max_output_tokens=output_limit,
        )

    def test_success_records_provider_tokens_request_ids_and_estimated_cost(self):
        result = SimpleNamespace(
            usage={
                "total_input_tokens": 20,
                "total_output_tokens": 5,
                "total_thought_tokens": 3,
                "total_tokens": 28,
            },
            request_id="provider-response-123",
        )
        with patch.object(ai_usage, "USD_TO_INR_RATE", "90"), \
                self.assertLogs(ai_usage.logger, level="INFO") as captured:
            self.call("operation-1", lambda: result)
        usage_records = [value for path, value in self.database.docs.items() if "/requests/" in path]
        self.assertEqual(len(usage_records), 1)
        record = usage_records[0]
        self.assertEqual(record["status"], "success")
        self.assertEqual(record["feature"], "tutor")
        self.assertEqual(record["model"], "gemini-3.8-flash")
        self.assertEqual(len(record["request_id"]), 64)
        self.assertNotIn("operation-1", record["request_id"])
        self.assertEqual(record["provider_request_id"], "provider-response-123")
        self.assertEqual((record["input_tokens"], record["output_tokens"], record["thinking_tokens"]), (20, 5, 3))
        self.assertEqual(record["estimated_cost_usd"], 0.000045)
        self.assertNotIn("private learner question", repr(record))
        self.assertNotIn("private learner question", " ".join(item.getMessage() for item in captured.records))
        usage_log = next(item.getMessage() for item in captured.records if "GEMINI_USAGE" in item.getMessage())
        self.assertIn("'input_tokens': 20", usage_log)
        self.assertIn("'output_tokens': 5", usage_log)
        self.assertIn("'thinking_tokens': 3", usage_log)
        self.assertIn("'estimated_cost_inr': 0.00405", usage_log)
        self.assertIn("'input_token_cost_inr_estimate': 0.00135", usage_log)

    def test_live_usage_logs_modality_costs_and_session_reserve_in_rupees(self):
        usage = {
            "input_tokens": 100,
            "output_tokens": 40,
            "thinking_tokens": 10,
            "total_tokens": 150,
            "prompt_tokens_details": [{"modality": "AUDIO", "token_count": 100}],
            "response_tokens_details": [{"modality": "AUDIO", "token_count": 40}],
        }
        with patch.object(ai_usage, "USD_TO_INR_RATE", "90"), \
                self.assertLogs(ai_usage.logger, level="INFO") as captured:
            ai_usage.log_live_usage(
                request_id="live-turn-1", model="gemini-3.8-live", usage=usage,
                session_reserved_cost_usd=2.0,
            )
        usage_log = next(item.getMessage() for item in captured.records if "GEMINI_LIVE_USAGE" in item.getMessage())
        self.assertIn("'input_tokens': 100", usage_log)
        self.assertIn("'output_tokens': 40", usage_log)
        self.assertIn("'estimated_token_cost_inr': 0.07425", usage_log)
        self.assertIn("'session_reserved_cost_inr': 180.0", usage_log)

    def test_duplicate_operation_id_never_invokes_provider_twice(self):
        result = SimpleNamespace(usage=None, request_id=None)
        invoke = Mock(return_value=result)
        self.call("operation-duplicate", invoke)
        with self.assertRaises(ai_usage.UsageLimitError):
            self.call("operation-duplicate", invoke)
        invoke.assert_called_once()

    def test_disabled_daily_limit_allows_calls_and_keeps_counting(self):
        invoke = Mock(return_value=SimpleNamespace(usage=None, request_id=None))
        with patch.object(ai_usage, "AI_DAILY_REQUEST_LIMIT", 1):
            self.call("daily-1", invoke)
            self.call("daily-2", invoke)
        self.assertEqual(invoke.call_count, 2)
        daily = next(value for path, value in self.database.docs.items() if "/daily/" in path)
        self.assertEqual(daily["request_count"], 2)

    def test_disabled_monthly_limit_allows_calls_and_keeps_accounting(self):
        invoke = Mock(return_value=SimpleNamespace(usage=None, request_id=None))
        with patch.object(ai_usage, "AI_MONTHLY_ESTIMATED_COST_LIMIT_USD", 0.00001):
            self.call("month-1", invoke)
            self.call("month-2", invoke)
        self.assertEqual(invoke.call_count, 2)
        month = next(value for path, value in self.database.docs.items() if "/monthly/" in path)
        records = [value for path, value in self.database.docs.items() if "/requests/" in path]
        self.assertGreater(month["reserved_estimated_cost_usd"], 0.00001)
        self.assertEqual(month["reserved_estimated_cost_usd"],
                         round(sum(record["reserved_estimated_cost_usd"] for record in records), 8))

    def test_disabled_caps_do_not_require_positive_limits(self):
        invoke = Mock(return_value=SimpleNamespace(usage=None, request_id=None))
        with patch.object(ai_usage, "AI_DAILY_REQUEST_LIMIT", 0), \
                patch.object(ai_usage, "AI_MONTHLY_ESTIMATED_COST_LIMIT_USD", 0):
            self.call("disabled-caps", invoke)
        invoke.assert_called_once()

    def test_missing_usage_is_recorded_as_unknown_and_reservation_is_retained(self):
        result = SimpleNamespace(usage=None, request_id="provider-response-unknown")
        self.call("usage-missing", lambda: result)
        request_record = next(value for path, value in self.database.docs.items() if "/requests/" in path)
        month_record = next(value for path, value in self.database.docs.items() if "/monthly/" in path)
        self.assertFalse(request_record["usage_metadata_available"])
        self.assertIsNone(request_record["input_tokens"])
        self.assertIsNone(request_record["output_tokens"])
        self.assertIsNone(request_record["thinking_tokens"])
        self.assertIsNone(request_record["estimated_cost_usd"])
        self.assertGreater(request_record["reserved_estimated_cost_usd"], 0)
        self.assertEqual(month_record["reserved_estimated_cost_usd"], request_record["reserved_estimated_cost_usd"])

    def test_failed_call_records_failure_without_zeroing_unknown_cost(self):
        with patch.object(ai_usage, "USD_TO_INR_RATE", "90"), \
                self.assertLogs(ai_usage.logger, level="INFO") as captured:
            with self.assertRaisesRegex(RuntimeError, "provider failure"):
                self.call("provider-failed", lambda: (_ for _ in ()).throw(RuntimeError("provider failure")))
        request_record = next(value for path, value in self.database.docs.items() if "/requests/" in path)
        month_record = next(value for path, value in self.database.docs.items() if "/monthly/" in path)
        self.assertEqual(request_record["status"], "failed")
        self.assertIsNone(request_record["input_tokens"])
        self.assertIsNone(request_record["estimated_cost_usd"])
        self.assertEqual(month_record["reserved_estimated_cost_usd"], request_record["reserved_estimated_cost_usd"])
        self.assertNotIn("provider failure", repr(request_record))
        usage_log = next(item.getMessage() for item in captured.records if "GEMINI_USAGE" in item.getMessage())
        self.assertIn("'status': 'failed'", usage_log)
        self.assertIn("'input_tokens': None", usage_log)
        self.assertIn("'reserved_estimated_cost_inr':", usage_log)

    def test_rejected_live_token_releases_reserve_without_retrying(self):
        for status in (400, 401, 403, 404, 422, 429):
            with self.subTest(status=status):
                invoke = Mock(side_effect=AIProviderError("gemini", "Token rejected", status))
                with self.assertRaises(AIProviderError):
                    ai_usage.run_tracked_provider_call(
                        feature="tutor_live_session", request_id=f"rejected-{status}",
                        model="gemini-3.8-live", prompt_content="saved context",
                        invoke=invoke, max_output_tokens=1, fixed_cost_usd=2.0,
                    )
                invoke.assert_called_once()
                month = next(value for path, value in self.database.docs.items() if "/monthly/" in path)
                self.assertEqual(month["reserved_estimated_cost_usd"], 0.0)
        records = [value for path, value in self.database.docs.items() if "/requests/" in path]
        self.assertEqual(len(records), 6)
        self.assertTrue(all(record["status"] == "failed" for record in records))
        self.assertTrue(all(record["estimated_cost_usd"] == 0.0 for record in records))

    def test_uncertain_live_failure_keeps_reserve_without_retrying(self):
        for status in (408, 500, 503, 504):
            with self.subTest(status=status):
                invoke = Mock(side_effect=AIProviderError("gemini", "Unknown outcome", status))
                with self.assertRaises(AIProviderError):
                    ai_usage.run_tracked_provider_call(
                        feature="tutor_live_session", request_id=f"uncertain-{status}",
                        model="gemini-3.8-live", prompt_content="saved context",
                        invoke=invoke, max_output_tokens=1, fixed_cost_usd=2.0,
                    )
                invoke.assert_called_once()
        records = [value for path, value in self.database.docs.items() if "/requests/" in path]
        month = next(value for path, value in self.database.docs.items() if "/monthly/" in path)
        self.assertEqual(month["reserved_estimated_cost_usd"],
                         round(sum(record["reserved_estimated_cost_usd"] for record in records), 8))
        self.assertTrue(all(record["estimated_cost_usd"] is None for record in records))

    def test_missing_pricing_blocks_before_provider_call(self):
        invoke = Mock()
        with (
            patch.object(ai_usage, "GEMINI_INPUT_PRICE_PER_MILLION_USD", None),
            self.assertRaisesRegex(ai_usage.UsageLimitError, "pricing is not configured"),
        ):
            self.call("price-missing", invoke)
        invoke.assert_not_called()

    def test_existing_daily_record_without_count_blocks_before_provider_call(self):
        now = ai_usage.datetime.now(ai_usage.timezone.utc)
        daily_ref, _, _ = ai_usage._request_refs(self.database, "tutor", "daily-corrupt", now)
        self.database.docs[daily_ref.path] = {"updated_at": "present but incomplete"}
        invoke = Mock()
        with self.assertRaisesRegex(ai_usage.UsageLimitError, "usage records need review"):
            self.call("daily-corrupt", invoke)
        invoke.assert_not_called()

    def test_existing_monthly_record_without_cost_blocks_before_provider_call(self):
        now = ai_usage.datetime.now(ai_usage.timezone.utc)
        _, monthly_ref, _ = ai_usage._request_refs(self.database, "tutor", "monthly-corrupt", now)
        self.database.docs[monthly_ref.path] = {"updated_at": "present but incomplete"}
        invoke = Mock()
        with self.assertRaisesRegex(ai_usage.UsageLimitError, "cost records need review"):
            self.call("monthly-corrupt", invoke)
        invoke.assert_not_called()


if __name__ == "__main__":
    unittest.main()
