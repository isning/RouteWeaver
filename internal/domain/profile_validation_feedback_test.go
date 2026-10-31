package domain_test

import (
	"errors"
	"fmt"
	"testing"

	"routeweaver/internal/domain"
)

func TestProfileMissingActionReferenceRetainsStableLocationThroughWrapping(t *testing.T) {
	for _, tc := range []struct {
		name          string
		mutate        func(*domain.ClientProfileIR)
		wantDetail    string
		wantReference domain.ActionRef
		wantLocation  domain.ProfileActionLocation
	}{
		{"default endpoint", func(p *domain.ClientProfileIR) { p.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed"} }, "defaultAction: endpoint reference missing", domain.ActionRef{Kind: "endpoint", Ref: "removed"}, domain.ProfileActionLocation{Kind: "default"}},
		{"group member", func(p *domain.ClientProfileIR) {
			p.Groups[1].Members = []domain.ActionRef{{Kind: "group", Ref: "removed"}}
		}, "groups[1]: group reference missing", domain.ActionRef{Kind: "group", Ref: "removed"}, domain.ProfileActionLocation{Kind: "group", ID: "g2"}},
		{"rule action", func(p *domain.ClientProfileIR) {
			p.Rules = []domain.PolicyRule{{ID: "rule-stable", Match: domain.MatchExpression{Op: "domain", Value: "example.org"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "removed"}}}
		}, "rules[0].action: endpoint reference missing", domain.ActionRef{Kind: "endpoint", Ref: "removed"}, domain.ProfileActionLocation{Kind: "rule", ID: "rule-stable"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := profile()
			tc.mutate(&p)
			err := domain.ValidateClientProfile(p)
			if err == nil || err.Error() != tc.wantDetail {
				t.Fatalf("legacy error changed: %v", err)
			}
			var missing *domain.MissingActionReferenceError
			if !errors.As(fmt.Errorf("compile profile: %w", err), &missing) || missing.Reference != tc.wantReference || missing.Location != tc.wantLocation {
				t.Fatalf("lost typed stable location: %#v", missing)
			}
		})
	}
}

func TestProfileMissingActionReferenceStillReportsFirstOccurrence(t *testing.T) {
	p := profile()
	p.Groups[0].Members = []domain.ActionRef{{Kind: "endpoint", Ref: "removed"}}
	p.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed"}
	p.Rules = []domain.PolicyRule{{ID: "rule-stable", Match: domain.MatchExpression{Op: "domain", Value: "example.org"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "removed"}}}
	err := domain.ValidateClientProfile(p)
	var missing *domain.MissingActionReferenceError
	if !errors.As(err, &missing) || missing.Location != (domain.ProfileActionLocation{Kind: "group", ID: "g1"}) || err.Error() != "groups[0]: endpoint reference missing" {
		t.Fatalf("first error changed: %v %#v", err, missing)
	}
}

func TestProfileActionReferenceLocationSurvivesRuleReorder(t *testing.T) {
	p := profile()
	p.Rules = []domain.PolicyRule{
		{ID: "good-rule", Match: domain.MatchExpression{Op: "domain", Value: "example.org"}, Action: domain.ActionRef{Kind: "direct"}},
		{ID: "missing-rule", Match: domain.MatchExpression{Op: "domain", Value: "example.net"}, Action: domain.ActionRef{Kind: "endpoint", Ref: "removed"}},
	}
	for _, detail := range []string{"rules[1].action: endpoint reference missing", "rules[0].action: endpoint reference missing"} {
		err := domain.ValidateClientProfile(p)
		var missing *domain.MissingActionReferenceError
		if !errors.As(err, &missing) || missing.Location.ID != "missing-rule" || err.Error() != detail {
			t.Fatalf("location used unstable position: %v %#v", err, missing)
		}
		p.Rules[0], p.Rules[1] = p.Rules[1], p.Rules[0]
	}
}

func TestProfileDoesNotClassifyOtherValidationAsMissingActionReference(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*domain.ClientProfileIR)
	}{
		{"empty reference", func(p *domain.ClientProfileIR) { p.DefaultAction = domain.ActionRef{Kind: "endpoint"} }},
		{"malformed reference", func(p *domain.ClientProfileIR) { p.DefaultAction = domain.ActionRef{Kind: "group", Ref: "invalid/ref"} }},
		{"built in reference", func(p *domain.ClientProfileIR) { p.DefaultAction = domain.ActionRef{Kind: "direct", Ref: "removed"} }},
		{"unknown action", func(p *domain.ClientProfileIR) { p.DefaultAction = domain.ActionRef{Kind: "mystery", Ref: "removed"} }},
		{"group cycle", func(p *domain.ClientProfileIR) { p.Groups[0].Members = []domain.ActionRef{{Kind: "group", Ref: "g3"}} }},
		{"resource match", func(p *domain.ClientProfileIR) {
			p.Rules = []domain.PolicyRule{{ID: "resource-rule", Match: domain.MatchExpression{Op: "resource", Value: "removed"}, Action: domain.ActionRef{Kind: "direct"}}}
		}},
		{"owner mismatch before missing", func(p *domain.ClientProfileIR) {
			p.Endpoints[0].OwnerID = "other"
			p.DefaultAction = domain.ActionRef{Kind: "endpoint", Ref: "removed"}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := profile()
			tc.mutate(&p)
			err := domain.ValidateClientProfile(p)
			var missing *domain.MissingActionReferenceError
			if err == nil || errors.As(err, &missing) {
				t.Fatalf("unrelated failure classified as missing action: %v %#v", err, missing)
			}
		})
	}
}
