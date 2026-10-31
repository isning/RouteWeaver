package managedxray

import (
	"context"
	"fmt"
	"reflect"

	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/common"
	"github.com/xtls/xray-core/features/routing"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/runtime/protoimpl"
	"google.golang.org/protobuf/types/descriptorpb"
)

// DispatcherConfig is the empty private protobuf constructor identity described
// in dispatcher.proto. The descriptor is assembled here to avoid a protoc build
// prerequisite. This does not alter or re-register any upstream Xray type.
type DispatcherConfig struct {
	state         protoimpl.MessageState
	unknownFields protoimpl.UnknownFields
	sizeCache     protoimpl.SizeCache
}

var configInfo = make([]protoimpl.MessageInfo, 1)

func (x *DispatcherConfig) Reset() {
	*x = DispatcherConfig{}
	protoimpl.X.MessageStateOf(protoimpl.Pointer(x)).StoreMessageInfo(&configInfo[0])
}
func (x *DispatcherConfig) String() string { return protoimpl.X.MessageStringOf(x) }
func (*DispatcherConfig) ProtoMessage()    {}
func (x *DispatcherConfig) ProtoReflect() protoreflect.Message {
	mi := &configInfo[0]
	if x != nil {
		ms := protoimpl.X.MessageStateOf(protoimpl.Pointer(x))
		if ms.LoadMessageInfo() == nil {
			ms.StoreMessageInfo(mi)
		}
		return ms
	}
	return mi.MessageOf(x)
}

type runtimeContextKey struct{}

func init() {
	raw, err := proto.Marshal(&descriptorpb.FileDescriptorProto{Name: proto.String("routeweaver/managedxray/dispatcher.proto"), Package: proto.String("routeweaver.managedxray"), Syntax: proto.String("proto3"), MessageType: []*descriptorpb.DescriptorProto{{Name: proto.String("DispatcherConfig")}}})
	if err != nil {
		panic(err)
	}
	type identity struct{}
	_ = protoimpl.TypeBuilder{File: protoimpl.DescBuilder{GoPackagePath: reflect.TypeOf(identity{}).PkgPath(), RawDescriptor: raw, NumMessages: 1}, GoTypes: []any{(*DispatcherConfig)(nil)}, MessageInfos: configInfo}.Build()
	common.Must(common.RegisterConfig((*DispatcherConfig)(nil), func(ctx context.Context, _ interface{}) (interface{}, error) {
		r, ok := ctx.Value(runtimeContextKey{}).(*Runtime)
		if !ok || r == nil {
			return nil, fmt.Errorf("managed dispatcher requires private runtime context")
		}
		inner, err := common.CreateObject(ctx, &dispatcher.Config{})
		if err != nil {
			return nil, err
		}
		return &managedDispatcher{inner: inner.(routing.Dispatcher), runtime: r}, nil
	}))
}
