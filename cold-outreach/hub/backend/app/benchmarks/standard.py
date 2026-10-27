"""The shape of a Website Standard (PLAN.md section 3.5 and SPEC section 6.5)."""

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Short = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Service(Strict):
    name: Short
    synonyms: list[Short] = Field(default_factory=list, max_length=20)
    must_have: bool = True


class ServicePage(Strict):
    min_words: int = Field(default=600, ge=0, le=20_000)
    min_sections: int = Field(default=4, ge=0, le=50)
    faq: bool = True
    price: bool = True
    own_photos: bool = True
    reviews: bool = True
    cta: bool = True
    service_area: bool = True


class LocationPage(Strict):
    min_words: int = Field(default=400, ge=0, le=20_000)
    city_in_title: bool = True
    local_content: bool = True
    local_photos: bool = True
    all_services_linked: bool = True
    local_reviews: bool = True
    map: bool = True
    faq: bool = True
    cta: bool = True
    max_shared_text_pct: int = Field(default=60, ge=0, le=100)


SUPPORTING_PAGES = ("FAQ", "Reviews", "Gallery", "About", "Contact", "Pricing")


class Blog(Strict):
    posts_per_month: float = Field(default=2, ge=0, le=100)
    topics: list[Short] = Field(default_factory=list, max_length=60)


class Standard(Strict):
    services: list[Service] = Field(default_factory=list, max_length=60)
    service_page: ServicePage = Field(default_factory=ServicePage)
    location_page: LocationPage = Field(default_factory=LocationPage)
    supporting_pages: list[Short] = Field(default_factory=lambda: list(SUPPORTING_PAGES))
    blog: Blog = Field(default_factory=Blog)
    mobile_lcp_seconds: float = Field(default=2.5, gt=0, le=60)

    @model_validator(mode="after")
    def _unique_services(self) -> "Standard":
        names = [s.name.lower() for s in self.services]
        if len(names) != len(set(names)):
            raise ValueError("each service may be listed once")
        return self

    def ready_problem(self) -> str | None:
        """Why this standard can't be locked yet, or None."""
        if not any(service.must_have for service in self.services):
            return "Add at least one must-have service."
        return None


def version_label(niche: str, version: int) -> str:
    """ "Cleaning", 2 -> "cleaning-v2"."""
    slug = "-".join(niche.lower().split())
    return f"{slug}-v{version}"
