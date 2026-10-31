package httpapi_test

import (
	"encoding/json"
	"routeweaver/internal/domain"
	"routeweaver/internal/httpapi"
	"strings"
	"testing"
)

func TestServerInventoryMismatchHasSafeScopedRecoveryIdentity(t *testing.T) {
	s, srv := makeServer(t)
	admin := operatorClient()
	tenant := inviteClient(t, s, srv, "inventory-drift-reader")
	instance := domain.CoreInstance{ID: "drift-core", HostID: "drift-host", Name: "FRA core", AdapterID: "routeweaver/xray", Version: "26.3.27"}
	listener := domain.ManagedEndpoint{ID: "drift-listener", InstanceID: instance.ID, Name: "FRA listener", Connection: domain.Connection{Protocol: "socks", Host: "0.0.0.0", Port: 1080, Username: "fixture-user", Password: "fixture-password"}}
	deployment := httpapi.ServerDeployment{ID: "drift-draft", Name: "Saved draft", IR: domain.ServerDeploymentIR{ID: "drift-draft", SchemaVersion: "1.0", TopologyRevision: "fixture-1", Programs: []domain.ServerProgram{{Instance: instance, Listener: listener}}}}
	for kind, value := range map[string]any{"core-instances": instance, "managed-endpoints": listener, "server-deployments": deployment} {
		id := instance.ID
		if kind == "managed-endpoints" {
			id = listener.ID
		}
		if kind == "server-deployments" {
			id = deployment.ID
		}
		if err := s.Put(kind, id, value); err != nil {
			t.Fatal(err)
		}
	}
	changed := listener
	changed.Connection.Password = "changed-fixture-password"
	if err := s.Put("managed-endpoints", changed.ID, changed); err != nil {
		t.Fatal(err)
	}
	opened := openServerDraft(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID)
	code, _, raw := validateOpenedServer(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID, opened["revisionToken"].(string))
	var response map[string]any
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	if code != 422 || response["code"] != "SERVER_LISTENER_CHANGED" || response["endpointId"] != listener.ID {
		t.Fatalf("expected scoped listener mismatch, got %d %s", code, raw)
	}
	if strings.Contains(raw, "fixture-password") || strings.Contains(raw, "fixture-user") {
		t.Fatal("mismatch leaked connection credentials")
	}
	code, _, raw = req(t, tenant.c, "POST", srv.URL+"/api/server-deployments/"+deployment.ID+"/validate", "", nil)
	if code != 403 || strings.Contains(raw, listener.ID) {
		t.Fatalf("tenant learned admin recovery identity: %d %s", code, raw)
	}
	if err := s.Put("managed-endpoints", listener.ID, listener); err != nil {
		t.Fatal(err)
	}
	currentInstance := instance
	currentInstance.Name = "Renamed core"
	if err := s.Put("core-instances", instance.ID, currentInstance); err != nil {
		t.Fatal(err)
	}
	opened = openServerDraft(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID)
	code, _, raw = validateOpenedServer(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID, opened["revisionToken"].(string))
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	if code != 422 || response["code"] != "SERVER_INSTANCE_CHANGED" || response["instanceId"] != instance.ID || strings.Contains(raw, "endpointId") {
		t.Fatalf("instance change misrepresented as listener change: %d %s", code, raw)
	}
	if err := s.Put("core-instances", instance.ID, instance); err != nil {
		t.Fatal(err)
	}
	deployment.IR.Programs[0].Listener.ID = "<private-marker>"
	if err := s.Put("server-deployments", deployment.ID, deployment); err != nil {
		t.Fatal(err)
	}
	opened = openServerDraft(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID)
	code, _, raw = validateOpenedServer(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID, opened["revisionToken"].(string))
	response = map[string]any{}
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		t.Fatal(err)
	}
	if code != 422 || response["code"] != "SERVER_INVENTORY_MISMATCH" || strings.Contains(raw, "private-marker") || strings.Contains(raw, "endpointId") {
		t.Fatal("invalid recovery identity was not safely omitted")
	}

	for _, kind := range []string{"listener", "instance"} {
		unknown := deployment
		unknown.IR.Programs = append([]domain.ServerProgram(nil), deployment.IR.Programs...)
		unknown.IR.Programs[0].Listener = listener
		unknown.IR.Programs[0].Instance = instance
		if kind == "listener" {
			unknown.IR.Programs[0].Listener.ID = "unknown-valid-listener"
		} else {
			unknown.IR.Programs[0].Instance.ID = "unknown-valid-instance"
		}
		if err := s.Put("server-deployments", deployment.ID, unknown); err != nil {
			t.Fatal(err)
		}
		opened = openServerDraft(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID)
		code, _, raw = validateOpenedServer(t, admin, srv.URL+"/api/server-deployments/"+deployment.ID, opened["revisionToken"].(string))
		response = map[string]any{}
		if err := json.Unmarshal([]byte(raw), &response); err != nil {
			t.Fatal(err)
		}
		if code != 422 || response["code"] != "SERVER_INVENTORY_MISMATCH" || strings.Contains(raw, "unknown-valid") || strings.Contains(raw, "endpointId") || strings.Contains(raw, "instanceId") {
			t.Errorf("unverified %s identity was not safely omitted: %d %s", kind, code, raw)
		}
	}

}
