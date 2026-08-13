import { describe, expect, it } from "vitest";
import {
	parseSaasLogLine,
	isSaasStackContinuation,
	normalizePlaceholder,
	groupSaasEvents,
	summarizeSaasEvent,
	analyzeSaasEvent,
	buildSaasDiagnosticEvent
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

describe("summarizeSaasEvent", () => {
	it("extracts JSON payloads, raw SQL, tenant route and exceptions from an event", () => {
		const events = groupSaasEvents([
			"2026-08-13 13:03:48.547  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : PosSaletoIvn:{\"saledate\":\"2026-06-15\",\"datatype\":\"I\",\"eshopflag\":\"f\",\"terid\":\"16\"}",
			"2026-08-13 13:03:48.547  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : :SELECT aa.warehouse_id id,bb.warehousecode from set_ter_define aa,set_inv_warehouse bb where aa.id=16",
			"2026-08-13 13:03:48.565  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.t.service.TransInterfaceImpl     : SK00001000_非登录用户>> 库存统一接口:{\"autopost\":\"N\",\"transtype\":\"$POS\",\"detaillist\":[{\"dutyid\":1123266}]}",
			"2026-08-13 13:03:48.576  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : pos回调函数>>{\"MSG\":\"单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31\",\"STATUS\":\"ERR\"}",
			"2026-08-13 13:03:48.576  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] com.sw.saas.tenant.TenantServiceImpl     : tenant:196, schema:sk00001000",
			"2026-08-13 13:03:48.576  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] com.sw.saas.datasource.SchemaDataSource  : current con info:sk00001000,null,2832996880440973688,647383448",
			"java.sql.SQLException: 单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31",
			"\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvn(PosSaleInterfaceImpl.java:622)"
		]);

		const summary = summarizeSaasEvent(events[0]);

		expect(summary.payloads).toHaveLength(3);
		expect(summary.payloads[0]).toMatchObject({
			label: "PosSaletoIvn",
			body: { saledate: "2026-06-15", datatype: "I", eshopflag: "f", terid: "16" }
		});
		expect(summary.payloads[2]).toMatchObject({
			label: "pos回调函数",
			body: {
				MSG: "单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31",
				STATUS: "ERR"
			}
		});
		expect(summary.sql[0].sql).toContain("SELECT aa.warehouse_id");
		expect(summary.tenant).toMatchObject({
			cus: "196",
			schema: "sk00001000",
			currentSchema: "sk00001000",
			currentTraceId: "2832996880440973688"
		});
		expect(summary.exceptions[0].type).toBe("java.sql.SQLException");
	});
});

describe("analyzeSaasEvent", () => {
	it("diagnoses invalid document date and callback retry evidence", () => {
		const event = groupSaasEvents([
			"2026-08-13 13:03:48.575  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.t.service.TransInterfaceImpl   : 单据日期不合法!输入日期应该在2026-07-01到2026-08-31",
			"2026-08-13 13:03:48.576  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl : pos回调函数>>{\"MSG\":\"单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31\",\"STATUS\":\"ERR\"}",
			"2026-08-13 13:03:48.577  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.d.t.service.DealwithdatalinkTask : 任务回调处理失败，将任务数据写回原redis，调用类：com.sw.saas.inv.possale.service.PosSaleInterfaceImpl，方法：PosSaletoIvnStr"
		])[0];

		const diagnosis = analyzeSaasEvent(event, summarizeSaasEvent(event));

		expect(diagnosis.confirmedFacts.join("\n")).toContain("单据日期:2026-06-15");
		expect(diagnosis.possibleCauses.join("\n")).toContain("业务日期不在当前允许的核算期");
		expect(diagnosis.recommendations.join("\n")).toContain("核算期");
		expect(diagnosis.confirmedFacts.join("\n")).toContain("任务回调处理失败");
	});

	it("diagnoses missing tenant route warnings", () => {
		const event = groupSaasEvents([
			"2026-08-13 13:03:48.135  WARN SKA00 app1 1 notraceid nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [pool-5-thread-1] c.sw.saas.datasource.RoutingDataSource   : can not find tenant database, domain:null, cus:null, tenant:null",
			"2026-08-13 13:03:48.135  WARN SKA00 app1 1 notraceid nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [pool-5-thread-1] com.sw.saas.datasource.SchemaDataSource  : can not find tenant db schma domain:null, cus:null"
		])[0];

		const diagnosis = analyzeSaasEvent(event, summarizeSaasEvent(event));

		expect(diagnosis.confirmedFacts.join("\n")).toContain("未找到租户数据库或schema");
		expect(diagnosis.possibleCauses.join("\n")).toContain("租户路由上下文缺失");
		expect(diagnosis.recommendations.join("\n")).toContain("domain/cus/tenant");
	});
});

describe("buildSaasDiagnosticEvent", () => {
	it("formats an event as a clear diagnostic result", () => {
		const event = groupSaasEvents([
			"2026-08-13 13:03:48.547  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : PosSaletoIvn:{\"saledate\":\"2026-06-15\",\"datatype\":\"I\",\"eshopflag\":\"f\",\"terid\":\"16\"}",
			"2026-08-13 13:03:48.559 DEBUG SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : pos 零售出库 流水明细:SELECT aa.id dutyid from set_pos_sale_daily aa where aa.terid='16'",
			"2026-08-13 13:03:48.575  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : PosSaletoIvn，异常：",
			"java.sql.SQLException: 单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31",
			"\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvn(PosSaleInterfaceImpl.java:622)",
			"\tat com.sw.saas.inv.possale.service.PosSaleInterfaceImpl.PosSaletoIvnStr(PosSaleInterfaceImpl.java:400)",
			"2026-08-13 13:03:48.576  INFO SKA00 app1 1 2832996880440973688 nosrt notimecost 0.0.0.0 nouser nodomain nouri --- [task-DealwithdatalinkTask-64] c.s.s.i.p.service.PosSaleInterfaceImpl   : pos回调函数>>{\"MSG\":\"单据日期:2026-06-15不合法!输入日期应该在2026-07-01到2026-08-31\",\"STATUS\":\"ERR\"}"
		])[0];
		const summary = summarizeSaasEvent(event);
		const diagnosis = analyzeSaasEvent(event, summary);

		const diagnostic = buildSaasDiagnosticEvent(event, summary, diagnosis);

		expect(diagnostic.summary).toMatchObject({
			result: "error",
			errorType: "java.sql.SQLException",
			rootCause: "业务日期不在当前允许的核算期或库存账期范围内。"
		});
		expect(diagnostic.summary.errorMessage).toContain("单据日期:2026-06-15");
		expect(diagnostic.summary.location).toMatchObject({
			className: "com.sw.saas.inv.possale.service.PosSaleInterfaceImpl",
			methodName: "PosSaletoIvn",
			fileName: "PosSaleInterfaceImpl.java",
			lineNumber: 622
		});
		expect(diagnostic.request?.label).toBe("PosSaletoIvn");
		expect(diagnostic.response?.label).toBe("pos回调函数");
		expect(diagnostic.sql[0].label).toBe("pos 零售出库 流水明细");
		expect(diagnostic.context.before.join("\n")).toContain("PosSaletoIvn:{");
		expect(diagnostic.context.error.join("\n")).toContain("java.sql.SQLException");
		expect(diagnostic.context.after.join("\n")).toContain("pos回调函数");
		expect(diagnostic.stackTrace[1]).toContain("PosSaleInterfaceImpl.java:622");
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
