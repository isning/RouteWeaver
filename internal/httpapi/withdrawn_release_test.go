package httpapi_test

import (
	"routeweaver/internal/controlprotocol"
	"routeweaver/internal/httpapi"
	"testing"
)

func TestWithdrawnStockCannotPreviewNewGrantButStopRemainsAvailable(t *testing.T) {
	f := newFleetFixture(t)
	var d httpapi.ServerDeployment
	if err := f.s.Get("server-deployments", f.in.DeploymentID, &d); err != nil {
		t.Fatal(err)
	}
	for i := range d.IR.Programs {
		d.IR.Programs[i].Instance.Version = "26.10.29"
		if err := f.s.Put("core-instances", d.IR.Programs[i].Instance.ID, d.IR.Programs[i].Instance); err != nil {
			t.Fatal(err)
		}
	}
	f.saveDeployment(t, d)
	for _, action := range []string{"start", "configure"} {
		f.in.Action = action
		f.post(t, "admin/fleet-batches/preview", f.in, 422)
	}
	opened := openServerDraft(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID)
	validation := requireServerValidation(t, operatorClient(), f.srv.URL+"/api/server-deployments/"+d.ID, opened["revisionToken"].(string))
	code, result, raw := req(t, operatorClient(), "POST", f.srv.URL+"/api/server-deployments/"+d.ID+"/publish", "", map[string]any{"operationId": "withdrawn-publish", "leaseSeconds": 300, "accessAllowed": true, "quotaCertain": true, "expectedFingerprint": validation["fingerprint"]})
	if code != 200 || result["code"] != "CORE_RELEASE_WITHDRAWN" || result["status"] != "definitively-rejected" {
		t.Fatalf("withdrawn direct publication: %d %s", code, raw)
	}
	var queued controlprotocol.Desired
	if err := f.s.Get("agent-desired", "fleet-a", &queued); err == nil {
		t.Fatal("withdrawn publication queued activation")
	}
	f.in.Action = "stop"
	f.post(t, "admin/fleet-batches/preview", f.in, 200)
}
func TestWithdrawnStockServiceCannotRefreshOrRecover(t *testing.T) {
	f, _, token, d := continuousFixture(t)
	d.CoreVersion = "26.10.29"
	if err := f.s.Put("agent-desired", d.InstanceID, d); err != nil {
		t.Fatal(err)
	}
	for _, absent := range []bool{false, true} {
		fact := liveServiceFact(d)
		if absent {
			fact.Observed.Identity = controlprotocol.Identity{}
		}
		status, _ := serviceHeartbeatRequest(t, f, token, fact)
		if status != 409 {
			t.Fatalf("withdrawn continuation accepted: %d", status)
		}
	}
}
