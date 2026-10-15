import { TradeRoom } from "@/components/trade/trade-room";

export default function TradePage({ params }: { params: { id: string } }) {
  return <TradeRoom id={params.id} />;
}
