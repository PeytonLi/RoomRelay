import syntheticRoom from "@/fixtures/room.synthetic.json";
import RoomsClient from "./rooms-client";

export default function RoomsPage() {
  return <RoomsClient initialGeometry={JSON.stringify(syntheticRoom, null, 2)} />;
}
