import { describe, expect, it } from "vitest";
import {
	parseSaasLogLine,
	isSaasStackContinuation,
	normalizePlaceholder,
	groupSaasEvents
} from "../src/parsers/saasLog.js";

describe("parseSaasLogLine", () => {
	it("parses the SaaS log header into structured fields", () => {
		const line =
			"2026-08-13 13:03:46.702  INFO SKA00 app1 1 7260455573299120857 nosrt notimecost 122.115.233.94 nouser ska00001000.shineway-soft.com /saas/api/promactivity/searchPromActivityRule --- [http-nio-8000-exec-1] c.sw.saas.datasource.RoutingDataSource   : tenant database: db1, domain:ska00001000.shineway-soft.com, cus:196";

		const parsed = parseSaasLogLine(line);

		expect(parsed).toMatchObject({
			timestamp: "2026-08-13T13:03:46.702",
			level: "INFO",
			system: "SKA00",
			app: "app1",
			node: "1",
			traceId: "7260455573299120857",
			srt: null,
			timecost: null,
			ip: "122.115.233.94",
			user: null,
			domain: "ska00001000.shineway-soft.com",
			uri: "/saas/api/promactivity/searchPromActivityRule",
			thread: "http-nio-8000-exec-1",
			logger: "c.sw.saas.datasource.RoutingDataSource",
			message: "tenant database: db1, domain:ska00001000.shineway-soft.com, cus:196"
		});
	});

	it("normalizes SaaS placeholder values to null", () => {
		const line =
			"2026-08-13 13:03:48.135  WARN SKA00 app1 1 notraceid nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [pool-5-thread-1] c.sw.saas.datasource.RoutingDataSource   : can not find tenant database, domain:null, cus:null, tenant:null";

		const parsed = parseSaasLogLine(line);

		expect(parsed).toMatchObject({
			level: "WARN",
			traceId: null,
			srt: null,
			timecost: null,
			ip: null,
			user: null,
			domain: null,
			uri: null,
			thread: "pool-5-thread-1"
		});
		expect(normalizePlaceholder("SKA00")).toBe("SKA00");
		expect(normalizePlaceholder("notraceid")).toBeNull();
	});

	it("returns null for Java stack continuation lines", () => {
		const line = "\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvn(PosSaleInterfaceImpl.java:622)";

		expect(parseSaasLogLine(line)).toBeNull();
		expect(isSaasStackContinuation(line)).toBe(true);
	});
});

describe("groupSaasEvents", () => {
	it("groups log lines by trace id and attaches stack continuation lines", () => {
		const lines = [
			"2026-08-13 13:03:46.501  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : PosSaletoIvn，异常：",
			"java.sql.SQLException: 单据日期:2026-06-16不合法!输入日期应该在2026-07-01到2026-08-31",
			"\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvn(PosSaleInterfaceImpl.java:622)",
			"2026-08-13 13:03:46.503  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.d.t.service.DealwithdatalinkTask   : 任务回调处理失败，将任务数据写回原redis，调用类：com.sw.saas.inv.possale.service.PosSaleInterfaceImpl，方法：PosSaletoIvnStr"
		];

		const events = groupSaasEvents(lines);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			traceId: "2832996880440973688",
			thread: "task-DealwithdatalinkTask-64",
			startTime: "2026-08-13T13:03:46.501",
			endTime: "2026-08-13T13:03:46.503",
			durationMs: 2
		});
		expect(events[0].entries).toHaveLength(2);
		expect(events[0].entries[0].continuations).toEqual([
			"java.sql.SQLException: 单据日期:2026-06-16不合法!输入日期应该在2026-07-01到2026-08-31",
			"\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvn(PosSaleInterfaceImpl.java:622)"
		]);
	});

	it("falls back to thread grouping when trace id is missing", () => {
		const lines = [
			"2026-08-13 13:03:48.134 DEBUG SKA00 app1 1 notraceid nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [pool-5-thread-1] c.sw.saas.datasource.RoutingDataSource   : tenant database: null, domain:null, cus:null",
			"2026-08-13 13:03:48.135  WARN SKA00 app1 1 notraceid nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [pool-5-thread-1] c.sw.saas.datasource.RoutingDataSource   : can not find tenant database, domain:null, cus:null, tenant:null"
		];

		const events = groupSaasEvents(lines);

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			traceId: null,
			thread: "pool-5-thread-1",
			key: "thread:pool-5-thread-1"
		});
		expect(events[0].levels).toEqual(["DEBUG", "WARN"]);
	});
});
